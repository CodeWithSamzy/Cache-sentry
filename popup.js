const findingsEl = document.getElementById("findings");
const documentsEl = document.getElementById("documents");
const skipsEl = document.getElementById("skips");
const toggleEl = document.getElementById("toggle-skips");
const exportEl = document.getElementById("export");

let currentFindings = [];

// Every value rendered below comes off the network, so nothing reaches
// innerHTML without going through here first.
function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function signalTags(evidence) {
  const tags = [];
  if (evidence?.extension) tags.push(`.${evidence.extension}`);
  if (evidence?.delimiter) tags.push(evidence.delimiter);
  return tags;
}

// The one-line answer to "why is this flagged?".
function whyText(evidence) {
  const contentType = evidence?.contentType || "a non-asset content type";
  const subject = evidence?.extension
    ? `a .${evidence.extension} URL`
    : "a static-looking URL";
  const delimiter = evidence?.delimiter ? ` containing ${evidence.delimiter}` : "";
  return `a ${contentType} response came back for ${subject}${delimiter}`;
}

function cacheText(cacheDetails = {}) {
  const parts = [];
  if (cacheDetails.cacheControl) parts.push(`cache-control: ${cacheDetails.cacheControl}`);
  if (cacheDetails.age) parts.push(`age: ${cacheDetails.age}`);
  if (cacheDetails.xCache) parts.push(`x-cache: ${cacheDetails.xCache}`);
  if (cacheDetails.cfCache) parts.push(`cf-cache-status: ${cacheDetails.cfCache}`);
  return parts.join(" \u00b7 ");
}

function findingHtml(finding) {
  const tags = signalTags(finding.evidence)
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join("");

  const count = finding.count || 1;
  const countHtml = count > 1 ? `<span class="count">\u00d7${escapeHtml(count)}</span>` : "";

  const cache = cacheText(finding.cacheDetails);
  const meta = [`status ${finding.status}`, cache].filter(Boolean).join(" \u00b7 ");

  return `
    <div class="finding">
      <div class="url">${tags}${escapeHtml(finding.url)}${countHtml}</div>
      <div class="why">${escapeHtml(whyText(finding.evidence))}</div>
      <div class="meta">${escapeHtml(meta)}</div>
    </div>
  `;
}

function render(findings) {
  currentFindings = findings || [];
  exportEl.disabled = currentFindings.length === 0;

  if (currentFindings.length === 0) {
    findingsEl.innerHTML = `<p class="empty">No cache deception signals on this page yet.</p>`;
    return;
  }

  findingsEl.innerHTML = currentFindings.map(findingHtml).join("");
}

// --- page loads (diagnostic) ------------------------------------------------
// The detector only speaks up when a URL looks like a static file, so a static
// *directory* path (`/resources/anything`, no extension) can be cached while the
// extension stays silent. This section reports what the cache did with the
// documents this tab loaded, which is what makes "did my URL get stored?"
// answerable at all.

function documentVerdict(doc) {
  const evidence = doc.sharedCacheEvidence || [];
  if (evidence.length) {
    return (
      `<span class="chip cached">from cache</span>` +
      escapeHtml(evidence.join(" \u00b7 "))
    );
  }

  const seen = doc.cacheControl
    ? `cache-control: ${doc.cacheControl}`
    : "no cache headers seen";
  return `<span class="chip fresh">no cache hit</span>${escapeHtml(seen)}`;
}

function documentHtml(doc) {
  const meta = [
    `status ${doc.status}`,
    doc.contentType || "no content-type",
    doc.hasSessionCookie ? "session cookie sent" : "no session cookie",
    new Date(doc.timestamp).toLocaleTimeString(),
  ];

  return `
    <div class="doc">
      <div class="url" title="${escapeHtml(doc.url)}">${escapeHtml(doc.url)}</div>
      <div class="verdict">${documentVerdict(doc)}</div>
      <div class="meta">${escapeHtml(meta.join(" \u00b7 "))}</div>
    </div>
  `;
}

function renderDocuments(loads) {
  if (!loads || loads.length === 0) {
    documentsEl.innerHTML = `<p class="empty">No page load recorded for this tab yet.</p>`;
    return;
  }

  documentsEl.innerHTML = loads.map(documentHtml).join("");
}

// --- rejected requests (diagnostic) -----------------------------------------
// "Nothing showed up" has two very different causes: no suspicious-looking URL
// was seen at all, or one was seen and a gate threw the finding away. The
// worker logs the second case, which is the only way to answer "I ran the
// vulnerable URL and nothing happened -- why?".

function skipReasonText(reason, detail) {
  if (reason === "no-session-cookie") {
    return "no session cookie was sent, so there was nothing private to leak";
  }
  if (reason === "not-document") {
    return detail
      ? `the response was served as ${detail}, not a document`
      : "the response was not a document";
  }
  if (reason === "no-body") {
    return `a ${detail} response carries no body, so there is nothing to compare`;
  }
  if (reason === "matches-url") {
    return detail
      ? `the response was served as ${detail}, which is what the URL already claims`
      : "the response matched the type the URL claims";
  }
  if (reason === "varies-on-credentials") {
    return `the response varies on ${detail || "credentials"}, so each user gets their own copy`;
  }
  if (reason === "not-cacheable") {
    return "the response had no headers a shared cache would keep";
  }
  return reason;
}

function skipHtml(skip) {
  return `
    <div class="skip">
      <div class="url" title="${escapeHtml(skip.url)}">${escapeHtml(skip.url)}</div>
      <div class="reason">Not flagged: ${escapeHtml(skipReasonText(skip.reason, skip.detail))}</div>
    </div>
  `;
}

function renderSkips(skips) {
  if (!skips || skips.length === 0) {
    skipsEl.innerHTML = `<p class="empty">No suspicious-looking request was rejected here.</p>`;
    return;
  }

  skipsEl.innerHTML = skips.map(skipHtml).join("");
}

toggleEl.addEventListener("click", () => {
  const opening = skipsEl.hidden;
  skipsEl.hidden = !opening;
  toggleEl.setAttribute("aria-expanded", String(opening));
  toggleEl.textContent = opening ? "Hide rejected requests" : "Why nothing flagged?";
});

// --- export -----------------------------------------------------------------

function buildReport(findings) {
  return {
    tool: "Cache Sentry",
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    note: "Signals only. Verify each URL manually before reporting it as a vulnerability.",
    findings: findings.map((finding) => ({
      url: finding.url,
      status: finding.status,
      count: finding.count || 1,
      signal: {
        extension: finding.evidence?.extension ?? null,
        delimiter: finding.evidence?.delimiter ?? null,
      },
      responseContentType: finding.evidence?.contentType ?? null,
      cache: finding.cacheDetails ?? null,
      lastSeen: new Date(finding.timestamp).toISOString(),
    })),
  };
}

exportEl.addEventListener("click", () => {
  if (currentFindings.length === 0) return;

  // A Blob download needs no extra permission; chrome.downloads would.
  const blob = new Blob([JSON.stringify(buildReport(currentFindings), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cache-sentry-findings-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

// --- bootstrap --------------------------------------------------------------

function load(tabId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_FINDINGS", tabId }, (findings) => {
      render(findings?.findings);
      chrome.runtime.sendMessage({ type: "GET_SKIPS", tabId }, (skips) => {
        renderSkips(skips?.skips);
        chrome.runtime.sendMessage({ type: "GET_DOCUMENTS", tabId }, (docs) => {
          renderDocuments(docs?.documents);
          resolve();
        });
      });
    });
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tabId = tabs[0]?.id;
  if (tabId) load(tabId);
});