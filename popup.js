const container = document.getElementById("findings");

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
  if (!findings || findings.length === 0) {
    container.innerHTML = `<p class="empty">No cache deception signals on this page yet.</p>`;
    return;
  }

  container.innerHTML = findings.map(findingHtml).join("");
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tabId = tabs[0]?.id;
  if (!tabId) return;

  chrome.runtime.sendMessage({ type: "GET_FINDINGS", tabId }, (response) => {
    render(response?.findings);
  });
});