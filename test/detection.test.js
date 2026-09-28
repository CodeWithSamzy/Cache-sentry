// Test harness for Cache Sentry.
// Loads the real background.js in a VM with a stubbed `chrome` API, then drives
// onBeforeSendHeaders/onHeadersReceived pairs through it and asserts on the
// resulting findings. No Chrome required.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert");

const ROOT = path.join(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");

// --- fixtures ---------------------------------------------------------------
// Response headers are written as [name, value] pairs.

const CACHEABLE = [["cache-control", "public, max-age=60"]];
const HTML = [["content-type", "text/html"]];
const HTML_CACHEABLE = [...HTML, ...CACHEABLE];

// Objects built inside the VM context use a different realm's prototypes, so
// deepStrictEqual rejects them on identity alone. Round-trip to plain JSON so
// values are still compared strictly.
const plain = (value) => JSON.parse(JSON.stringify(value));

// --- harness ----------------------------------------------------------------

// Fresh sandbox per test so findings/pending state never bleed across cases.
// Pass a shared `storage` object to simulate a service worker restart.
function loadWorker({ storage = {}, liveTabs, failStorage = false } = {}) {
  const L = {};
  const badges = {};
  const session = storage;
  const clone = (v) => JSON.parse(JSON.stringify(v));

  const chrome = {
    webRequest: {
      onBeforeSendHeaders: { addListener: (fn) => (L.send = fn) },
      onHeadersReceived: { addListener: (fn) => (L.recv = fn) },
      onErrorOccurred: { addListener: (fn) => (L.error = fn) },
    },
    action: {
      setBadgeText: ({ tabId, text }) => (badges[tabId] = text),
      setBadgeBackgroundColor: () => {},
    },
    // Backed by a plain object so a test can share it across "restarts".
    storage: {
      session: {
        // Deliberately not async: a synchronous throw is the worst case, and
        // the worker must survive it.
        get: (key) => {
          if (failStorage) throw new Error("storage unavailable");
          return Promise.resolve(key in session ? { [key]: clone(session[key]) } : {});
        },
        set: (obj) => {
          if (failStorage) throw new Error("storage unavailable");
          for (const [k, v] of Object.entries(obj)) session[k] = clone(v);
          return Promise.resolve();
        },
      },
    },
    tabs: {
      onRemoved: { addListener: (fn) => (L.removed = fn) },
      query: async () => (liveTabs ?? [1, 2, 3]).map((id) => ({ id })),
    },
    webNavigation: { onBeforeNavigate: { addListener: (fn) => (L.nav = fn) } },
    runtime: { onMessage: { addListener: (fn) => (L.msg = fn) } },
  };

  const ctx = vm.createContext({ chrome, console });
  vm.runInContext(
    SOURCE +
      "\n;globalThis.__findings = (t) => findingsByTab[t] || [];" +
      "\n;globalThis.__skips = (t) => recentSkips[t] || [];" +
      "\n;globalThis.__documents = (t) => recentDocuments[t] || [];" +
      "\nglobalThis.__hydrated = hydrated;",
    ctx,
    { filename: "background.js" }
  );

  let seq = 0;
  const send = ({ url, tabId = 1, cookie = "session=abc123", requestHeaders }) =>
    L.send({
      requestId: `${++seq}`,
      url,
      tabId,
      requestHeaders:
        requestHeaders ??
        (cookie ? [{ name: "Cookie", value: cookie }] : []),
    });

  const receive = ({ url, tabId = 1, status = 200, type = "main_frame", responseHeaders = [] }) =>
    L.recv({
      requestId: `${seq}`,
      url,
      tabId,
      type,
      statusCode: status,
      responseHeaders: responseHeaders.map(([name, value]) => ({ name, value })),
    });

  const request = (opts) => {
    send(opts);
    if (opts.responseHeaders !== undefined || opts.status !== undefined) {
      receive(opts);
    }
  };

  // Reads the worker's live state. The message path is covered separately.
  const findings = (tabId = 1) => ctx.__findings(tabId);

  // Exercises the real chrome.runtime.onMessage handler.
  const findingsViaMessage = (tabId = 1) =>
    new Promise((resolve) => {
      L.msg({ type: "GET_FINDINGS", tabId }, null, (r) => resolve(r.findings));
    });

  // The skip log: what looked suspicious but was rejected, and why.
  const skips = (tabId = 1) => ctx.__skips(tabId);

  const skipsViaMessage = (tabId = 1) =>
    new Promise((resolve) => {
      L.msg({ type: "GET_SKIPS", tabId }, null, (r) => resolve(r.skips));
    });

  // The page-load readout: what the cache did with each main document.
  const documents = (tabId = 1) => ctx.__documents(tabId);

  const documentsViaMessage = (tabId = 1) =>
    new Promise((resolve) => {
      L.msg({ type: "GET_DOCUMENTS", tabId }, null, (r) => resolve(r.documents));
    });

  // Let the storage read and any fire-and-forget writes settle.
  const settle = () =>
    Promise.resolve(ctx.__hydrated).then(
      () => new Promise((r) => setImmediate(r))
    );

  const navigate = (tabId = 1) =>
    L.nav({ frameId: 0, tabId, url: "https://example.com/" });

  return {
    send, receive, request, findings, findingsViaMessage, skips, skipsViaMessage,
    documents, documentsViaMessage,
    settle, navigate, badges, L, ctx, storage: session,
  };
}

// --- the core signal --------------------------------------------------------

test("flags a document served under a static-looking URL", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/nonexistent.js",
    responseHeaders: HTML_CACHEABLE,
  });
  assert.strictEqual(w.findings().length, 1);
  assert.strictEqual(w.findings()[0].status, 200);
  assert.strictEqual(w.badges[1], "1");
});

test("flags a JSON payload under an asset URL", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/api/me/profile.css",
    responseHeaders: [["content-type", "application/json"], ...CACHEABLE],
  });
  assert.strictEqual(w.findings().length, 1);
});

test("flags an image URL that answers with HTML", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/user/avatar.png",
    responseHeaders: HTML_CACHEABLE,
  });
  assert.strictEqual(w.findings().length, 1);
});

test("flags on X-Cache/CF-Cache-Status alone with no cache-control", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/acct/x.css",
    responseHeaders: [...HTML, ["x-cache", "Hit from cloudfront"]],
  });
  assert.strictEqual(w.findings().length, 1);
  assert.strictEqual(w.findings()[0].cacheDetails.xCache, "Hit from cloudfront");

  const w2 = loadWorker();
  w2.request({
    url: "https://example.com/acct/x.css",
    responseHeaders: [...HTML, ["cf-cache-status", "HIT"]],
  });
  assert.strictEqual(w2.findings().length, 1);
});

test("flags encoded delimiter paths", () => {
  for (const url of [
    "https://example.com/my-account%2e%2e%2fsecret",
    "https://example.com/my-account%2f%2fsecret",
    "https://example.com/my-account%00",
    "https://example.com/my-account%23",
    "https://example.com/my-account%3f",
  ]) {
    const w = loadWorker();
    w.request({ url, responseHeaders: HTML_CACHEABLE });
    assert.strictEqual(w.findings().length, 1, `expected a flag for ${url}`);
  }
});

test("flags a semicolon path parameter", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/shop;color=red/checkout",
    responseHeaders: HTML_CACHEABLE,
  });
  assert.strictEqual(w.findings().length, 1);
});

test("flags when a session cookie rides along with analytics cookies", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/a/x.js",
    cookie: "_ga=GA1.2.123; session=abc123",
    responseHeaders: HTML_CACHEABLE,
  });
  assert.strictEqual(w.findings().length, 1);
});

// --- gates that suppress a finding ------------------------------------------

test("does not flag when no cookie was sent", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/nonexistent.js",
    cookie: "",
    responseHeaders: HTML_CACHEABLE,
  });
  assert.strictEqual(w.findings().length, 0);
});

test("does not flag a request with only analytics cookies", () => {
  for (const cookie of ["_ga=GA1.2.123", "_gid=1; _fbp=fb.1", "__cf_bm=abc; _hjSession=1"]) {
    const w = loadWorker();
    w.request({
      url: "https://example.com/my-account/x.js",
      cookie,
      responseHeaders: HTML_CACHEABLE,
    });
    assert.strictEqual(w.findings().length, 0, `should ignore cookie: ${cookie}`);
  }
});

test("does not flag an empty cookie header", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/x.js",
    cookie: "   ",
    responseHeaders: HTML_CACHEABLE,
  });
  assert.strictEqual(w.findings().length, 0);
});

test("does not flag cache-control: no-store", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/nonexistent.js",
    responseHeaders: [...HTML, ["cache-control", "no-store, private"]],
  });
  assert.strictEqual(w.findings().length, 0);
});

test("does not flag a normal dynamic path even when cacheable", () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/dashboard", responseHeaders: HTML_CACHEABLE });
  assert.strictEqual(w.findings().length, 0);
});

test("does not flag when no cache signals are present at all", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/x.js",
    responseHeaders: [["content-type", "text/html"]],
  });
  assert.strictEqual(w.findings().length, 0);
});

test("does not flag a benign path-based session id", () => {
  for (const url of [
    "https://example.com/shop;jsessionid=9A2B3C",
    "https://example.com/shop;phpsessid=9A2B3C",
    "https://example.com/shop;aspsessionid=9A2B3C",
  ]) {
    const w = loadWorker();
    w.request({ url, responseHeaders: HTML_CACHEABLE });
    assert.strictEqual(w.findings().length, 0, `should ignore ${url}`);
  }
});

// --- Vary: a cache keyed on credentials cannot leak across users ------------

test("does not flag a response that varies on Cookie", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/x.js",
    responseHeaders: [...HTML_CACHEABLE, ["vary", "Cookie"]],
  });
  assert.strictEqual(w.findings().length, 0);
});

test("does not flag a response that varies on Authorization", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/x.js",
    responseHeaders: [...HTML_CACHEABLE, ["vary", "Authorization"]],
  });
  assert.strictEqual(w.findings().length, 0);
});

test("does not flag Vary: * (the response must not be reused at all)", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/x.js",
    responseHeaders: [...HTML_CACHEABLE, ["vary", "*"]],
  });
  assert.strictEqual(w.findings().length, 0);
});

test("does not flag a comma-separated Vary that includes a credential", () => {
  for (const vary of [
    "Accept-Encoding, Cookie",
    "accept-encoding,cookie",
    "Accept-Encoding, Authorization",
  ]) {
    const w = loadWorker();
    w.request({
      url: "https://example.com/my-account/x.js",
      responseHeaders: [...HTML_CACHEABLE, ["vary", vary]],
    });
    assert.strictEqual(w.findings().length, 0, `should suppress Vary: ${vary}`);
  }
});

test("does not flag when a second Vary header names a credential", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/x.js",
    responseHeaders: [
      ...HTML_CACHEABLE,
      ["vary", "Accept-Encoding"],
      ["vary", "Cookie"],
    ],
  });
  assert.strictEqual(w.findings().length, 0);
});

test("still flags a Vary that does not separate users", () => {
  for (const vary of [
    "Accept-Encoding",
    "Origin, User-Agent",
    "Accept-Language, Accept-Encoding",
  ]) {
    const w = loadWorker();
    w.request({
      url: "https://example.com/my-account/x.js",
      responseHeaders: [...HTML_CACHEABLE, ["vary", vary]],
    });
    assert.strictEqual(w.findings().length, 1, `should still flag Vary: ${vary}`);
  }
});

test("a field name that merely starts with a credential word is not a match", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/x.js",
    responseHeaders: [...HTML_CACHEABLE, ["vary", "CookieMonster, Authorizationz"]],
  });
  assert.strictEqual(w.findings().length, 1);
});

// --- skip log: why a suspicious-looking request was not flagged -------------

test("records a rejection when the request carried no session cookie", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/x.js",
    cookie: "",
    responseHeaders: HTML_CACHEABLE,
  });
  assert.strictEqual(w.findings().length, 0);
  assert.strictEqual(w.skips().length, 1);
  assert.strictEqual(w.skips()[0].reason, "no-session-cookie");
  assert.strictEqual(w.skips()[0].url, "https://example.com/my-account/x.js");
});

test("records the content type that contradicted the URL", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/static-app.js",
    responseHeaders: [["content-type", "text/javascript"], ...CACHEABLE],
  });
  const skip = w.skips()[0];
  assert.strictEqual(skip.reason, "not-document");
  assert.strictEqual(skip.detail, "text/javascript");
});

test("records which field suppressed a credential-varying response", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/x.js",
    responseHeaders: [...HTML_CACHEABLE, ["vary", "Accept-Encoding, Cookie"]],
  });
  assert.strictEqual(w.skips()[0].reason, "varies-on-credentials");
  assert.strictEqual(w.skips()[0].detail, "cookie");
});

test("records a response with no shared-cache headers", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/x.js",
    responseHeaders: [["content-type", "text/html"]],
  });
  assert.strictEqual(w.skips()[0].reason, "not-cacheable");
});

test("stays quiet about URLs that never looked suspicious", () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/dashboard", responseHeaders: HTML_CACHEABLE });
  w.request({ url: "https://example.com/api/user", responseHeaders: HTML_CACHEABLE });
  assert.strictEqual(w.skips().length, 0, "ordinary URLs must not fill the skip log");
});

test("a flagged request leaves no skip entry", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/x.js",
    responseHeaders: HTML_CACHEABLE,
  });
  assert.strictEqual(w.findings().length, 1);
  assert.strictEqual(w.skips().length, 0);
});

test("skips are kept per tab and capped", () => {
  const w = loadWorker();
  for (let i = 0; i < 30; i++) {
    w.request({
      url: "https://example.com/a/f" + i + ".js",
      cookie: "",
      responseHeaders: HTML_CACHEABLE,
    });
  }
  assert.strictEqual(w.skips().length, 20, "capped at 20");

  w.request({
    url: "https://example.com/other/x.js",
    tabId: 2,
    cookie: "",
    responseHeaders: HTML_CACHEABLE,
  });
  assert.strictEqual(w.skips(2).length, 1);
  assert.strictEqual(w.skips(1).length, 20);
});

test("the newest skip is first", () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/a/first.js", cookie: "", responseHeaders: HTML_CACHEABLE });
  w.request({ url: "https://example.com/a/second.js", cookie: "", responseHeaders: HTML_CACHEABLE });
  assert.match(w.skips()[0].url, /second\.js$/);
});

test("skips are exposed over the message API and cleared with the tab", async () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/a/x.js", cookie: "", responseHeaders: HTML_CACHEABLE });
  const viaMessage = await w.skipsViaMessage(1);
  assert.strictEqual(viaMessage.length, 1);

  w.L.removed(1);
  assert.strictEqual(w.skips().length, 0);
});

// --- false positives that used to fire on every site ------------------------

test("FALSE POSITIVE FIX: a real script is not flagged", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/static/app.js",
    responseHeaders: [
      ["content-type", "text/javascript"],
      ["cache-control", "public, max-age=31536000, immutable"],
    ],
  });
  assert.strictEqual(w.findings().length, 0, "ordinary JS assets must not be flagged");
});

test("FALSE POSITIVE FIX: a real stylesheet is not flagged", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/assets/site.css",
    responseHeaders: [["content-type", "text/css"], ...CACHEABLE],
  });
  assert.strictEqual(w.findings().length, 0);
});

test("FALSE POSITIVE FIX: a real image is not flagged", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/assets/logo.png",
    responseHeaders: [["content-type", "image/png"], ...CACHEABLE],
  });
  assert.strictEqual(w.findings().length, 0);
});

test("FALSE POSITIVE FIX: a CDN serving an opaque asset type is not flagged", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/static/app.js",
    responseHeaders: [
      ["content-type", "application/octet-stream"],
      ...CACHEABLE,
    ],
  });
  assert.strictEqual(w.findings().length, 0);
});

test("FALSE POSITIVE FIX: a missing content-type is not treated as a mismatch", () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/static/app.js", responseHeaders: CACHEABLE });
  assert.strictEqual(w.findings().length, 0);
});

test("FALSE POSITIVE FIX: a literal fragment is not a signal", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/docs#install",
    responseHeaders: HTML_CACHEABLE,
  });
  assert.strictEqual(w.findings().length, 0, "fragments never reach the server");
});

// --- bookkeeping ------------------------------------------------------------

test("keeps findings isolated per tab", () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/a/x.js", tabId: 1, responseHeaders: HTML_CACHEABLE });
  w.request({ url: "https://example.com/a/y.js", tabId: 2, responseHeaders: HTML_CACHEABLE });
  assert.strictEqual(w.findings(1).length, 1);
  assert.strictEqual(w.findings(2).length, 1);
  assert.match(w.findings(1)[0].url, /x\.js$/);
});

test("ignores non-tab requests (tabId < 0)", () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/a/x.js", tabId: -1, responseHeaders: HTML_CACHEABLE });
  assert.strictEqual(w.findings(-1).length, 0);
});

test("caps stored findings at 50 per tab", () => {
  const w = loadWorker();
  for (let i = 0; i < 60; i++) {
    w.request({ url: `https://example.com/a/f${i}.js`, responseHeaders: HTML_CACHEABLE });
  }
  assert.strictEqual(w.findings().length, 50);
});

test("repeats of the same URL collapse into one row with a count", () => {
  const w = loadWorker();
  for (let i = 0; i < 5; i++) {
    w.request({ url: "https://example.com/poll/x.js", responseHeaders: HTML_CACHEABLE });
  }
  assert.strictEqual(w.findings().length, 1, "one row per URL");
  assert.strictEqual(w.findings()[0].count, 5);
  assert.strictEqual(w.badges[1], "1", "badge counts distinct URLs");
});

test("a repeat hit refreshes the row and moves it to the front", () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/a/x.js", responseHeaders: HTML_CACHEABLE });
  w.request({ url: "https://example.com/b/y.css", responseHeaders: HTML_CACHEABLE });
  assert.match(w.findings()[0].url, /b\/y\.css$/);

  w.request({
    url: "https://example.com/a/x.js",
    responseHeaders: [...HTML, ["cache-control", "public, max-age=999"]],
  });
  assert.strictEqual(w.findings().length, 2, "still one row per URL");
  assert.match(w.findings()[0].url, /a\/x\.js$/, "most recent activity first");
  assert.strictEqual(w.findings()[0].count, 2);
  assert.strictEqual(
    w.findings()[0].cacheDetails.cacheControl,
    "public, max-age=999",
    "the freshest response wins"
  );
});

test("repeats do not evict other URLs from the cap", () => {
  const w = loadWorker();
  for (let i = 0; i < 40; i++) {
    w.request({ url: "https://example.com/poll/x.js", responseHeaders: HTML_CACHEABLE });
  }
  for (let i = 0; i < 20; i++) {
    w.request({
      url: "https://example.com/other/f" + i + ".js",
      responseHeaders: HTML_CACHEABLE,
    });
  }
  assert.strictEqual(w.findings().length, 21, "polling must not crowd out distinct URLs");
});

test("evidence records what made the URL look suspicious", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account/x.js",
    responseHeaders: HTML_CACHEABLE,
  });
  const evidence = w.findings()[0].evidence;
  assert.strictEqual(evidence.extension, "js");
  assert.strictEqual(evidence.delimiter, null);
  assert.strictEqual(evidence.contentType, "text/html");
});

test("evidence records a delimiter match and no extension", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/my-account%2e%2e%2fsecret",
    responseHeaders: HTML_CACHEABLE,
  });
  const evidence = w.findings()[0].evidence;
  assert.strictEqual(evidence.extension, null);
  assert.strictEqual(evidence.delimiter, "%2e%2e");
});

test("reports null cache details rather than undefined in the payload", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/a/x.js",
    responseHeaders: [...HTML, ["age", "42"]],
  });
  assert.deepStrictEqual(plain(w.findings()[0].cacheDetails), {
    cacheControl: null, age: "42", xCache: null, cfCache: null,
  });
});

test("empty findings returns an empty array, not undefined", () => {
  const w = loadWorker();
  assert.deepStrictEqual(plain(w.findings(99)), []);
});

test("clears findings when a tab closes", () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/a/x.js", responseHeaders: HTML_CACHEABLE });
  w.L.removed(1);
  assert.strictEqual(w.findings().length, 0);
});

test("abandoned requests are dropped from pendingRequests", () => {
  const w = loadWorker();
  w.send({ url: "https://example.com/a/x.js" });
  assert.strictEqual(vm.runInContext("Object.keys(pendingRequests).length", w.ctx), 1);
  w.L.error({ requestId: "1" });
  assert.strictEqual(vm.runInContext("Object.keys(pendingRequests).length", w.ctx), 0);
});

// --- regression: real Chrome delivers onBeforeNavigate AFTER the main
// document's response headers, so a blanket wipe erased the finding for the
// page being navigated to. Verified against Chrome 153. ---

test("REGRESSION: finding survives onBeforeNavigate for the same URL", () => {
  const w = loadWorker();
  const url = "https://example.com/my-account/nonexistent.js";
  w.request({ url, responseHeaders: HTML_CACHEABLE });
  assert.strictEqual(w.findings().length, 1, "finding should be recorded on the response");
  w.L.nav({ frameId: 0, tabId: 1, url });
  assert.strictEqual(w.findings().length, 1, "navigation must not erase the finding for that page");
  assert.strictEqual(w.badges[1], "1");
});

test("navigation to a different URL still clears the previous document's findings", () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/a/x.js", responseHeaders: HTML_CACHEABLE });
  assert.strictEqual(w.findings().length, 1);
  w.L.nav({ frameId: 0, tabId: 1, url: "https://example.com/other-page" });
  assert.strictEqual(w.findings().length, 0);
  assert.strictEqual(w.badges[1], "");
});

test("iframe navigations do not clear findings", () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/a/x.js", responseHeaders: HTML_CACHEABLE });
  w.L.nav({ frameId: 7, tabId: 1, url: "https://example.com/iframe" });
  assert.strictEqual(w.findings().length, 1);
});

// --- persistence: MV3 service workers are killed after ~30s idle ---

test("findings survive a service worker restart", async () => {
  const store = {};
  const w1 = loadWorker({ storage: store });
  w1.request({ url: "https://example.com/a/x.js", responseHeaders: HTML_CACHEABLE });
  assert.strictEqual(w1.findings().length, 1);
  await w1.settle();
  assert.ok(store.findingsByTab, "findings should be written to storage.session");

  const w2 = loadWorker({ storage: store });
  assert.strictEqual(w2.findings().length, 0, "a fresh worker starts empty");
  await w2.settle();
  assert.strictEqual(w2.findings().length, 1, "findings should hydrate from storage");
  assert.strictEqual(w2.findings()[0].url, "https://example.com/a/x.js");
});

test("badge count is restored from storage on restart", async () => {
  const store = {};
  const w1 = loadWorker({ storage: store });
  w1.request({ url: "https://example.com/a/x.js", responseHeaders: HTML_CACHEABLE });
  await w1.settle();

  const w2 = loadWorker({ storage: store });
  await w2.settle();
  assert.strictEqual(w2.badges[1], "1");
});

test("GET_FINDINGS waits for the storage read before answering", async () => {
  const store = {
    findingsByTab: {
      1: [{ url: "https://example.com/late.js", status: 200, cacheDetails: {} }],
    },
  };
  const w = loadWorker({ storage: store });
  const found = await w.findingsViaMessage(1);
  assert.strictEqual(found.length, 1, "popup must not be told there is nothing yet");
  assert.strictEqual(found[0].url, "https://example.com/late.js");
});

test("the worker still boots and records when storage throws", async () => {
  const w = loadWorker({ storage: {}, failStorage: true });
  await w.settle();
  w.request({ url: "https://example.com/a/x.js", responseHeaders: HTML_CACHEABLE });
  assert.strictEqual(w.findings().length, 1, "findings must still work in memory");
  assert.strictEqual(w.badges[1], "1");
});

test("stale tabs are pruned on hydration", async () => {
  const store = {
    findingsByTab: {
      1: [{ url: "https://example.com/live.js" }],
      99: [{ url: "https://example.com/dead.js" }],
    },
  };
  const w = loadWorker({ storage: store, liveTabs: [1] });
  await w.settle();
  assert.strictEqual(w.findings(1).length, 1);
  assert.strictEqual(w.findings(99).length, 0);
  assert.ok(!("99" in store.findingsByTab), "pruned entry should not be written back");
});

test("hydration does not prune when the tab query returns nothing", async () => {
  const store = { findingsByTab: { 7: [{ url: "https://example.com/a.js" }] } };
  const w = loadWorker({ storage: store, liveTabs: [] });
  await w.settle();
  assert.strictEqual(w.findings(7).length, 1, "an empty tab list must not wipe findings");
});

test("closing a tab clears its persisted findings", async () => {
  const store = {};
  const w = loadWorker({ storage: store });
  w.request({ url: "https://example.com/a/x.js", responseHeaders: HTML_CACHEABLE });
  await w.settle();
  assert.ok("1" in store.findingsByTab);
  w.L.removed(1);
  await w.settle();
  assert.ok(!("1" in store.findingsByTab), "closed tab should be gone from storage");
});

// --- manifest sanity ---

test("manifest references files that exist", () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.strictEqual(m.manifest_version, 3);
  for (const r of [m.background.service_worker, m.action.default_popup]) {
    assert.ok(fs.existsSync(path.join(ROOT, r)), `missing referenced file: ${r}`);
  }
  for (const size of Object.values(m.icons ?? {})) {
    assert.ok(fs.existsSync(path.join(ROOT, size)), `missing icon: ${size}`);
  }
});

test("manifest asks only for permissions it uses", () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.deepStrictEqual([...m.permissions].sort(), ["storage", "webNavigation", "webRequest"]);
  assert.ok(!m.permissions.includes("tabs"), "tabs is not needed");
  assert.ok(!m.permissions.includes("activeTab"), "activeTab is not needed");
});

test("manifest ships an icon at every size Chrome asks for", () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  for (const size of ["16", "32", "48", "128"]) {
    assert.ok(m.icons?.[size], "manifest has no " + size + "px icon");
    assert.strictEqual(
      m.action.default_icon?.[size],
      m.icons[size],
      "the toolbar icon for " + size + "px must match the store icon"
    );
  }
});

test("the extension version matches package.json", () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.strictEqual(m.version, pkg.version, "bump both together");
});

// --- page loads: the "was this stored?" readout ------------------------------
// The detector only analyses URLs that look like static files, so the shape a
// static *directory* cache rule needs is invisible to it. These cover the
// readout that exists precisely for those URLs.

test("records a main document even when the URL never looked suspicious", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/resources/private",
    responseHeaders: [
      ["content-type", "text/html"],
      ["cache-control", "public, max-age=60"],
    ],
  });

  assert.strictEqual(w.findings().length, 0, "a bare directory path is not a finding");
  const doc = w.documents()[0];
  assert.strictEqual(doc.url, "https://example.com/resources/private");
  assert.strictEqual(doc.contentType, "text/html");
  assert.strictEqual(doc.cacheControl, "public, max-age=60");
  assert.strictEqual(doc.hasSessionCookie, true, "the cookie is what makes it interesting");
  assert.deepStrictEqual(plain(doc.sharedCacheEvidence), []);
});

test("ignores sub-resources when recording page loads", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/resources/app.js",
    type: "script",
    responseHeaders: [["content-type", "text/javascript"]],
  });
  w.request({
    url: "https://example.com/resources/site.css",
    type: "stylesheet",
    responseHeaders: [["content-type", "text/css"]],
  });
  assert.strictEqual(w.documents().length, 0, "only the main document is a page load");
});

test("reports a load that a shared cache actually served", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/resources/private",
    responseHeaders: [
      ["content-type", "text/html"],
      ["cache-control", "public, max-age=60"],
      ["age", "7"],
      ["x-cache", "HIT"],
    ],
  });
  assert.deepStrictEqual(plain(w.documents()[0].sharedCacheEvidence), [
    "age: 7",
    "x-cache: HIT",
  ]);
});

test("a cache miss is not reported as proof of caching", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/resources/private",
    responseHeaders: [
      ["content-type", "text/html"],
      ["cache-control", "public, max-age=60"],
      ["age", "0"],
      ["x-cache", "miss"],
    ],
  });
  assert.deepStrictEqual(plain(w.documents()[0].sharedCacheEvidence), []);
});

test("a CDN hit marker counts even without an Age", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/resources/private",
    responseHeaders: [["content-type", "text/html"], ["cf-cache-status", "HIT"]],
  });
  assert.deepStrictEqual(plain(w.documents()[0].sharedCacheEvidence), [
    "cf-cache-status: HIT",
  ]);
});

test("keeps the last five page loads, newest first", () => {
  const w = loadWorker();
  for (let i = 0; i < 7; i++) {
    w.request({ url: "https://example.com/page" + i, responseHeaders: HTML });
  }
  const urls = w.documents().map((doc) => doc.url);
  assert.strictEqual(urls.length, 5, "capped at 5");
  assert.match(urls[0], /page6$/, "newest first");
  assert.match(urls[4], /page2$/);
});

test("a reload is kept as its own history entry", () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/resources/x", responseHeaders: HTML });
  w.request({
    url: "https://example.com/resources/x",
    responseHeaders: [...HTML, ["age", "3"], ["x-cache", "HIT"]],
  });
  assert.strictEqual(w.documents().length, 2, "the first and second visit must both show");
  assert.deepStrictEqual(plain(w.documents()[0].sharedCacheEvidence), ["age: 3", "x-cache: HIT"]);
  assert.deepStrictEqual(plain(w.documents()[1].sharedCacheEvidence), []);
});

test("page loads are per tab and cleared with the tab", () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/a", tabId: 1, responseHeaders: HTML });
  w.request({ url: "https://example.com/b", tabId: 2, responseHeaders: HTML });

  assert.strictEqual(w.documents(1).length, 1);
  assert.strictEqual(w.documents(2).length, 1);

  w.L.removed(1);
  assert.strictEqual(w.documents(1).length, 0);
  assert.strictEqual(w.documents(2).length, 1, "closing one tab must not clear another");
});

test("page loads are exposed over the message API", async () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/a", responseHeaders: HTML });
  const viaMessage = await w.documentsViaMessage(1);
  assert.strictEqual(viaMessage.length, 1);
  assert.strictEqual(viaMessage[0].url, "https://example.com/a");
});

test("ignores a document load for a non-tab request", () => {
  const w = loadWorker();
  w.request({ url: "https://example.com/a", tabId: -1, responseHeaders: HTML });
  assert.strictEqual(w.documents(-1).length, 0);
});

test("records a document load whose request headers were never seen", () => {
  const w = loadWorker();
  w.L.recv({
    requestId: "999",
    url: "https://example.com/a",
    tabId: 1,
    statusCode: 200,
    type: "main_frame",
    responseHeaders: [{ name: "content-type", value: "text/html" }],
  });
  assert.strictEqual(w.documents().length, 1, "a missed cookie read must not hide the page");
  assert.strictEqual(w.documents()[0].hasSessionCookie, false);
});

// --- false positives found on a real site (x.com) ----------------------------
// Two of these fired on every X page load: a 304 whose leftover text/html type
// was read as "a document came back", and .json endpoints whose JSON response
// was read as contradicting a .json URL.

test("FALSE POSITIVE FIX: a .json URL that answers with JSON is not flagged", () => {
  const w = loadWorker();
  w.request({
    url: "https://x.com/i/api/1.1/hashflags.json",
    responseHeaders: [
      ["content-type", "application/json;charset=utf-8"],
      ["cache-control", "public, max-age=1800"],
      ["cf-cache-status", "DYNAMIC"],
    ],
  });
  assert.strictEqual(w.findings().length, 0, "JSON under a .json URL is what it promised");
  assert.strictEqual(w.skips()[0].reason, "matches-url");
  assert.strictEqual(w.skips()[0].detail, "application/json;charset=utf-8");
});

test("a source map that answers with JSON is not flagged", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/static/app.js.map",
    responseHeaders: [["content-type", "application/json"], ...CACHEABLE],
  });
  assert.strictEqual(w.findings().length, 0, "a source map really is JSON");
});

test("a .json URL that answers with HTML is still flagged", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/api/me/profile.json",
    responseHeaders: HTML_CACHEABLE,
  });
  assert.strictEqual(w.findings().length, 1, "an HTML document under .json is the shape");
});

test("FALSE POSITIVE FIX: a 304 has no body to contradict the URL", () => {
  const w = loadWorker();
  w.request({
    url: "https://api.x.com/1.1/help/settings.json?include_zero_rate=true",
    status: 304,
    responseHeaders: [
      ["content-type", "text/html;charset=utf-8"],
      ["cache-control", "no-cache, no-store, must-revalidate, pre-check=0, post-check=0"],
      ["cf-cache-status", "DYNAMIC"],
    ],
  });
  assert.strictEqual(w.findings().length, 0, "a 304 serves no body at all");
  assert.strictEqual(w.skips()[0].reason, "no-body");
  assert.strictEqual(w.skips()[0].detail, "304");
});

test("a 204 counts as bodyless too", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/acct/save.css",
    status: 204,
    responseHeaders: HTML_CACHEABLE,
  });
  assert.strictEqual(w.findings().length, 0);
  assert.strictEqual(w.skips()[0].reason, "no-body");
});

test("FALSE POSITIVE FIX: cf-cache-status: DYNAMIC is not evidence of caching", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/acct/me.js",
    responseHeaders: [...HTML, ["cf-cache-status", "DYNAMIC"]],
  });
  assert.strictEqual(w.findings().length, 0, "DYNAMIC means the cache declined to store it");
  assert.strictEqual(w.skips()[0].reason, "not-cacheable");
});

test("x-cache: MISS is not evidence of caching either", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/acct/me.js",
    responseHeaders: [...HTML, ["x-cache", "MISS"]],
  });
  assert.strictEqual(w.findings().length, 0);
  assert.strictEqual(w.skips()[0].reason, "not-cacheable");
});

test("no-store still suppresses next to a non-hit cache status", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/acct/me.js",
    responseHeaders: [
      ...HTML,
      ["cache-control", "no-cache, no-store, must-revalidate"],
      ["cf-cache-status", "DYNAMIC"],
    ],
  });
  assert.strictEqual(w.findings().length, 0);
  assert.strictEqual(w.skips()[0].reason, "not-cacheable");
});

test("a real hit beats no-store, because a broken cache is the finding", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/acct/me.js",
    responseHeaders: [...HTML, ["cache-control", "no-store"], ["x-cache", "HIT"]],
  });
  assert.strictEqual(w.findings().length, 1);
});

test("a non-zero Age is proof of a shared cache on its own", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/acct/me.js",
    responseHeaders: [...HTML, ["age", "42"]],
  });
  assert.strictEqual(w.findings().length, 1);
});

test("a cookie-less 304 is still reported as having no session cookie", () => {
  const w = loadWorker();
  w.request({
    url: "https://example.com/acct/me.css",
    cookie: "",
    status: 304,
    responseHeaders: HTML_CACHEABLE,
  });
  assert.strictEqual(w.skips()[0].reason, "no-session-cookie");
});
