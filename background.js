// Cache Sentry — background service worker
// Passively watches network traffic for the classic web cache deception
// signature: a request carrying a session cookie that gets a cacheable
// response on a URL shaped like a static asset or containing delimiter
// characters known to confuse cache/origin parsing.

const pendingRequests = {};

// Requests that looked suspicious but were rejected, newest first, per tab.
// Without this, "nothing showed up" is indistinguishable from "a gate threw it
// away", which is the first question when testing a target that should be
// vulnerable. Not persisted: it is a debugging aid, not a finding.
const recentSkips = {};
const SKIP_LIMIT = 20;

function recordSkip(tabId, url, reason, detail) {
  if (tabId < 0) return;
  const skips = recentSkips[tabId] || (recentSkips[tabId] = []);
  skips.unshift({ url, reason, detail: detail ?? null, timestamp: Date.now() });
  if (skips.length > SKIP_LIMIT) skips.length = SKIP_LIMIT;
}
// Main-document loads per tab, newest first. This is the readout that answers
// "what did the cache actually do with the page I just loaded?", including for
// URLs the detector ignores on purpose (an ordinary asset, or a static
// directory path with no file extension at all). In memory only, like the skip
// log: it is a debugging aid, not a finding.
const recentDocuments = {};
const DOCUMENT_LIMIT = 5;

// Proof that a shared cache served this response, as opposed to merely being
// allowed to store it: an Age above zero, or a hit marker from a CDN. A miss
// does not count, and neither does a bare Cache-Control.
function sharedCacheEvidence(headers) {
  const age = headerValue(headers, "age");
  const xCache = headerValue(headers, "x-cache");
  const cfCache = headerValue(headers, "cf-cache-status");

  return [
    age != null && Number(age) > 0 ? `age: ${age}` : null,
    xCache && /hit/i.test(xCache) ? `x-cache: ${xCache}` : null,
    cfCache && /hit/i.test(cfCache) ? `cf-cache-status: ${cfCache}` : null,
  ].filter(Boolean);
}

function recordDocumentLoad(tabId, url, status, headers, hasSessionCookie) {
  if (tabId < 0) return;

  const loads = recentDocuments[tabId] || (recentDocuments[tabId] = []);
  loads.unshift({
    url,
    status,
    timestamp: Date.now(),
    hasSessionCookie: !!hasSessionCookie,
    contentType: headerValue(headers, "content-type"),
    cacheControl: headerValue(headers, "cache-control"),
    sharedCacheEvidence: sharedCacheEvidence(headers),
  });
  if (loads.length > DOCUMENT_LIMIT) loads.length = DOCUMENT_LIMIT;
}

// Findings are keyed by tabId -> array of finding objects. MV3 kills the
// service worker after ~30s idle, so the in-memory copy is backed by
// chrome.storage.session: it survives worker restarts but is cleared when the
// browser closes, which is the right lifetime for per-tab findings.
const SESSION_KEY = "findingsByTab";
let findingsByTab = {};

const sessionArea = chrome.storage?.session;

const hydrated = (async () => {
  if (!sessionArea) return;

  const data = await sessionArea.get(SESSION_KEY);
  const stored = data[SESSION_KEY] || {};

  // The worker is usually woken *by* the very request we are about to record,
  // so a finding can land while this read is still in flight. Merge instead of
  // overwriting, or that finding would be wiped and the wipe persisted.
  for (const [key, storedFindings] of Object.entries(stored)) {
    const current = findingsByTab[key];
    if (!current) {
      findingsByTab[key] = storedFindings;
      continue;
    }
    const seen = new Set(current.map((finding) => finding.id));
    findingsByTab[key] = current
      .concat(storedFindings.filter((finding) => !seen.has(finding.id)))
      .slice(0, 50);
  }

  // Drop findings for tabs that no longer exist. Guard against an empty tab
  // list so a failed query can never wipe every finding.
  const tabs = await chrome.tabs.query({});
  if (tabs.length > 0) {
    const live = new Set(tabs.map((t) => t.id));
    for (const key of Object.keys(findingsByTab)) {
      if (!live.has(Number(key))) delete findingsByTab[key];
    }
  }

  for (const [key, findings] of Object.entries(findingsByTab)) {
    chrome.action.setBadgeText({
      tabId: Number(key),
      text: findings.length ? String(findings.length) : "",
    });
  }

  persist();
})().catch(() => {});

function persist() {
  if (!sessionArea) return;
  try {
    Promise.resolve(sessionArea.set({ [SESSION_KEY]: findingsByTab })).catch(() => {});
  } catch {
    // Storage unavailable: findings stay in memory for this worker's lifetime.
  }
}

// A URL that claims to be a static asset. On its own this means nothing --
// genuine assets look exactly like this -- so the response has to contradict it.
const STATIC_ASSET_PATH =
  /\.(?:css|js|mjs|json|png|jpe?g|gif|ico|svg|webp|woff2?|ttf|eot|map)(?=$|[?#;])/i;

// Delimiters that make a cache and an origin disagree about what a URL means.
// A literal "#" is deliberately absent: fragments never reach the server. Path
// based session ids (;jsessionid=, ;phpsessid=) are ordinary and excluded.
const DELIMITER_PATH =
  /%2e%2e|%2f%2f|%00|%23|%3f|;(?!jsessionid|phpsessid|aspsessionid)/i;

// The actual cache deception signal: a private document or API payload served
// under a URL that looks like a static file. A genuine asset answers as
// javascript/css/image, so a document response is the contradiction we want.
const DOCUMENT_CONTENT_TYPE =
  /^\s*(?:text\/html|text\/plain|application\/(?:json|xml)|text\/xml|application\/xhtml\+xml)/i;

// Cookies that are never a session credential. A request carrying only these is
// not authenticated traffic and cannot be leaking a private page.
const NON_SESSION_COOKIE =
  /^(?:__utm|__cf|_ga|_gid|_gat|_gac_|_gcl_|_fbp|_fbc|_hj|_pk_|_uet|_clck|_clsk|_shopify_|_pin_|amplitude|mp_|intercom|optimizely|ajs_|segment|mixpanel|snowplow|optanon|cf_clearance)/i;

function headerValue(headers, name) {
  const header = headers.find((h) => h.name.toLowerCase() === name);
  return header ? header.value : null;
}

function carriesSessionCookie(cookieValue) {
  return String(cookieValue)
    .split(";")
    .map((pair) => pair.split("=")[0].trim())
    .filter(Boolean)
    .some((name) => !NON_SESSION_COOKIE.test(name));
}

// A cache that keys on Cookie or Authorization stores a separate entry per
// user, so it cannot hand one user's response to another. Vary: * means the
// response must not be reused at all. Either way this is not the deception we
// are looking for. Vary values are comma separated and may repeat.
const CREDENTIAL_VARY = new Set([
  "*",
  "cookie",
  "authorization",
  "proxy-authorization",
]);

function credentialVaryFields(headers) {
  return headers
    .filter((h) => h.name.toLowerCase() === "vary")
    .map((h) => h.value)
    .join(",")
    .split(",")
    .map((field) => field.trim().toLowerCase())
    .filter((field) => CREDENTIAL_VARY.has(field));
}

function isDocumentResponse(headers) {
  const contentType = headerValue(headers, "content-type");
  return !!contentType && DOCUMENT_CONTENT_TYPE.test(contentType);
}

// Statuses that carry no body, so their Content-Type describes nothing. X
// answers .json endpoints with a 304 carrying a leftover text/html type, which
// is not "a document came back" and must not be read as one.
const BODYLESS_STATUS = new Set([204, 304]);

function hasBody(statusCode) {
  if (typeof statusCode !== "number") return true;
  return statusCode >= 200 && !BODYLESS_STATUS.has(statusCode);
}

// Extensions whose file type is one of the document types above: a .json file
// really is JSON, and so is a source map. The response only counts as a
// contradiction when the extension cannot explain it, which is what stops every
// authenticated JSON API call from being flagged.
const SELF_DESCRIBING = new Set(["json", "map"]);

function contradictsUrl(extension, headers) {
  if (!extension) return true;

  const contentType = headerValue(headers, "content-type");
  if (!contentType) return true;

  const base = contentType.split(";")[0].trim().toLowerCase();
  if (SELF_DESCRIBING.has(String(extension).toLowerCase())) {
    return !/json$/.test(base);
  }

  return true;
}

// A cache header only proves a response came from a cache when it says so.
// Cloudflare sends `cf-cache-status: DYNAMIC` on nearly every API response,
// and reading that as cacheable flagged normal authenticated traffic.
function cacheStatusIsHit(value) {
  return !!value && /hit/i.test(value);
}

function isCacheableResponse(headers) {
  const cacheControl = headerValue(headers, "cache-control");
  const age = headerValue(headers, "age");
  const xCache = headerValue(headers, "x-cache");
  const cfCache = headerValue(headers, "cf-cache-status");

  const explicitlyPrivate =
    !!cacheControl && /no-store|private/i.test(cacheControl);

  // Proof it was actually served by a shared cache. A hit beats everything:
  // a response that says no-store and still came back as a hit is a broken
  // cache, which is worth reporting.
  const servedFromCache =
    cacheStatusIsHit(xCache) ||
    cacheStatusIsHit(cfCache) ||
    (age != null && Number(age) > 0);

  // Permission to store it, which is all a first, uncached response can show.
  const allowsSharing = !explicitlyPrivate && (cacheControl != null || age != null);

  const looksCacheable = servedFromCache || allowsSharing;

  return {
    looksCacheable: !!looksCacheable,
    details: {
      cacheControl: cacheControl ?? null,
      age: age ?? null,
      xCache: xCache ?? null,
      cfCache: cfCache ?? null,
    },
  };
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const cookieHeader = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === "cookie"
    );
    pendingRequests[details.requestId] = {
      url: details.url,
      tabId: details.tabId,
      hasSessionCookie:
        !!cookieHeader && carriesSessionCookie(cookieHeader.value),
    };
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const info = pendingRequests[details.requestId];
    delete pendingRequests[details.requestId];

    // Recorded before any heuristic runs, and before the early return below:
    // the readout has to cover the pages the detector ignores on purpose, or
    // it cannot answer whether the cache stored them.
    if (details.type === "main_frame") {
      recordDocumentLoad(
        details.tabId,
        details.url,
        details.statusCode,
        details.responseHeaders || [],
        info?.hasSessionCookie
      );
    }

    if (!info) return;

    const assetMatch = STATIC_ASSET_PATH.exec(info.url);
    const delimiterMatch = DELIMITER_PATH.exec(info.url);
    if (!assetMatch && !delimiterMatch) return;
    if (details.tabId < 0) return;

    const headers = details.responseHeaders || [];

    // Past this point the request looked interesting, so every rejection is
    // recorded with its reason rather than returning silently.
    if (!info.hasSessionCookie) {
      recordSkip(details.tabId, info.url, "no-session-cookie");
      return;
    }

    // A bodyless response has no Content-Type worth comparing.
    if (!hasBody(details.statusCode)) {
      recordSkip(
        details.tabId,
        info.url,
        "no-body",
        String(details.statusCode)
      );
      return;
    }

    // The URL only looks suspicious; the response has to back it up. An asset
    // URL answering with a document is what a successful deception looks like,
    // and requiring it is what removes ordinary static-asset noise.
    if (!isDocumentResponse(headers)) {
      recordSkip(
        details.tabId,
        info.url,
        "not-document",
        headerValue(headers, "content-type")
      );
      return;
    }

    // The response has to contradict what the URL claims to be. A .json URL
    // answering with JSON is exactly what it promised.
    if (!contradictsUrl(assetMatch ? assetMatch[0].slice(1) : null, headers)) {
      recordSkip(
        details.tabId,
        info.url,
        "matches-url",
        headerValue(headers, "content-type")
      );
      return;
    }

    // A response that varies on credentials is not shared between users, so
    // there is nothing here for a cache to leak.
    const credentialFields = credentialVaryFields(headers);
    if (credentialFields.length) {
      recordSkip(
        details.tabId,
        info.url,
        "varies-on-credentials",
        credentialFields.join(", ")
      );
      return;
    }

    const { looksCacheable, details: cacheDetails } =
      isCacheableResponse(headers);
    if (!looksCacheable) {
      recordSkip(details.tabId, info.url, "not-cacheable");
      return;
    }

    const timestamp = Date.now();

    // What made this look suspicious, kept so the popup can explain itself
    // rather than showing raw headers and leaving the reading to the user.
    const evidence = {
      extension: assetMatch ? assetMatch[0].slice(1).toLowerCase() : null,
      delimiter: delimiterMatch ? delimiterMatch[0] : null,
      contentType: headerValue(headers, "content-type"),
    };

    const findings = findingsByTab[info.tabId] || [];
    const existing = findings.find((f) => f.url === info.url);

    if (existing) {
      // One row per URL. A polling endpoint would otherwise fill the whole list
      // with repeats and push every other finding out of the cap below.
      existing.count = (existing.count || 1) + 1;
      existing.status = details.statusCode;
      existing.evidence = evidence;
      existing.cacheDetails = cacheDetails;
      existing.timestamp = timestamp;
      findingsByTab[info.tabId] = [existing].concat(
        findings.filter((f) => f !== existing)
      );
    } else {
      findingsByTab[info.tabId] = [
        {
          id: `${details.requestId}-${timestamp}`,
          url: info.url,
          status: details.statusCode,
          count: 1,
          evidence,
          cacheDetails,
          timestamp,
        },
      ].concat(findings);
    }

    findingsByTab[info.tabId] = findingsByTab[info.tabId].slice(0, 50);

    chrome.action.setBadgeText({
      tabId: info.tabId,
      text: String(findingsByTab[info.tabId].length),
    });
    chrome.action.setBadgeBackgroundColor({
      tabId: info.tabId,
      color: "#d98e30",
    });

    persist();
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => {
  delete findingsByTab[tabId];
  delete recentSkips[tabId];
  delete recentDocuments[tabId];
  persist();
});

// A request that never produces headers must not linger in pendingRequests.
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    delete pendingRequests[details.requestId];
  },
  { urls: ["<all_urls>"] }
);

chrome.webNavigation?.onBeforeNavigate?.addListener((details) => {
  if (details.frameId !== 0) return;

  // Chrome can deliver onBeforeNavigate after the main document's response
  // headers, so wiping every finding here would erase the finding for the very
  // page being navigated to. Keep findings that belong to the incoming URL and
  // drop only those from the outgoing document.
  const kept = (findingsByTab[details.tabId] || []).filter(
    (f) => f.url === details.url
  );
  findingsByTab[details.tabId] = kept;
  chrome.action.setBadgeText({
    tabId: details.tabId,
    text: kept.length ? String(kept.length) : "",
  });
  persist();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_SKIPS") {
    sendResponse({ skips: recentSkips[message.tabId] || [] });
    return;
  }
  if (message.type === "GET_DOCUMENTS") {
    sendResponse({ documents: recentDocuments[message.tabId] || [] });
    return;
  }
  if (message.type !== "GET_FINDINGS") return;

  // Wait for the storage read before answering: a popup opened right after the
  // worker starts would otherwise be told there is nothing to show.
  hydrated.then(() => {
    sendResponse({ findings: findingsByTab[message.tabId] || [] });
  });
  return true;
});