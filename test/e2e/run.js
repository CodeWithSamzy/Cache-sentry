#!/usr/bin/env node
// Browser tests. These cover what a stubbed `chrome` API cannot: real event
// ordering, the real service worker lifecycle, and the popup's rendered DOM.
//
// Chrome 137+ branded builds ignore --load-extension and
// --disable-extensions-except, so the extension is loaded over CDP with
// Extensions.loadUnpacked instead. That needs --enable-unsafe-extension-debugging.
//
// Set CHROME_PATH to point at a specific Chrome binary.
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { CDP, closeAll } = require("./cdp");
const fixtures = require("./fixtures");

const EXTENSION_DIR = path.join(__dirname, "..", "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function launch(chromePath, profileDir, port) {
  const child = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-crash-reporter",
      "--disable-breakpad",
      "--no-proxy-server",
      "--enable-unsafe-extension-debugging",
      "--user-data-dir=" + profileDir,
      "--remote-debugging-port=" + port,
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/json/version");
      if (response.ok) return child;
    } catch {}
    await sleep(300);
  }
  throw new Error("Chrome never exposed a debugging port");
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  } catch {}
}

async function openSession(port) {
  const list = async () => (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  const version = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
  const browser = await CDP.connect(version.webSocketDebuggerUrl);
  const { id: extensionId } = await browser.send("Extensions.loadUnpacked", {
    path: EXTENSION_DIR,
  });

  const workerTarget = await (async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const found = (await list()).find(
        (target) => target.type === "service_worker" && target.url.endsWith("/background.js")
      );
      if (found) return found;
      await sleep(250);
    }
    throw new Error("the extension service worker never appeared");
  })();

  const worker = await CDP.connect(workerTarget.webSocketDebuggerUrl);

  const snapshot = async () =>
    JSON.parse(await worker.eval("hydrated.then(() => JSON.stringify(findingsByTab))", true));

  const visit = async (url, settleMs = 1600) => {
    await browser.send("Target.createTarget", { url });
    await sleep(settleMs);
  };

  return {
    browser,
    list,
    worker,
    workerTarget,
    extensionId,
    snapshot,
    visit,
    popupUrl: "chrome-extension://" + extensionId + "/popup.html",
  };
}

const flaggedPaths = (snapshot) => {
  const paths = new Set();
  for (const findings of Object.values(snapshot)) {
    for (const finding of findings) paths.add(new URL(finding.url).pathname);
  }
  return paths;
};

const tabHolding = (snapshot, suffix) =>
  Object.keys(snapshot).find((tabId) => snapshot[tabId].some((f) => f.url.endsWith(suffix)));

// --- scenarios --------------------------------------------------------------
// Declarative ones just name the paths they visit and whether each must flag.

const pathScenarios = [
  {
    name: "a document under an asset URL flags; ordinary assets and matching types do not",
    paths: {
      "/deception.js": true,
      "/static-app.js": false,
      "/asset.png": false,
      "/no-store.js": false,
      "/plain.html": false,
      "/api/me.json": false,
    },
  },
  {
    name: "Vary on credentials suppresses, other Vary does not",
    paths: {
      "/vary-cookie.js": false,
      "/vary-star.js": false,
      "/vary-encoding.js": true,
    },
  },
];

async function runPathScenario(session, origin, scenario) {
  for (const target of Object.keys(scenario.paths)) await session.visit(origin + target);
  const flagged = flaggedPaths(await session.snapshot());

  const problems = [];
  for (const [target, expected] of Object.entries(scenario.paths)) {
    const got = flagged.has(target);
    if (got !== expected) problems.push(`${target}: flagged=${got}, expected=${expected}`);
  }
  return problems;
}

async function runPopupScenario(session, origin) {
  const problems = [];

  await session.visit(origin + "/popup-target.js", 2000);
  // Reload: the same URL twice must collapse into one row with a count.
  const page = (await session.list()).find((t) => t.url.endsWith("/popup-target.js"));
  const pageConn = await CDP.connect(page.webSocketDebuggerUrl);
  await pageConn.send("Page.reload");
  await sleep(2200);
  pageConn.close();

  await session.visit(origin + "/hostile.js", 1800);

  const snapshot = await session.snapshot();
  const tabId = tabHolding(snapshot, "popup-target.js");
  const row = (snapshot[tabId] || []).find((f) => f.url.endsWith("popup-target.js"));
  if (row?.count !== 2) {
    problems.push(`repeated URL should collapse to count 2, got ${row?.count}`);
  }

  await session.browser.send("Target.createTarget", { url: session.popupUrl });
  await sleep(1500);
  const popupTarget = (await session.list()).find((t) => t.url === session.popupUrl);
  const popup = await CDP.connect(popupTarget.webSocketDebuggerUrl);

  const render = async (forTab) => {
    const response = await popup.eval(
      `new Promise(r => chrome.runtime.sendMessage({type:"GET_FINDINGS",tabId:${forTab}}, resp => r(JSON.stringify(resp))))`,
      true
    );
    await popup.eval(`render(${JSON.stringify(JSON.parse(response).findings)})`);
    return popup.eval('document.getElementById("findings").innerText');
  };

  const text = await render(tabId);
  if (!text.includes("\u00d72")) problems.push("popup did not show the x2 count");
  if (!/text\/html response came back for a \.js URL/.test(text)) {
    problems.push("popup did not explain why it fired");
  }
  if (!/x-cache: HIT/.test(text)) problems.push("popup did not show the cache evidence");

  // The export is the only thing that leaves the popup, so check its shape.
  const report = JSON.parse(
    await popup.eval("JSON.stringify(buildReport(currentFindings))")
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8")
  );
  if (report.version !== manifest.version) {
    problems.push("the export reported version " + report.version);
  }
  if (report.findings.length !== 1) {
    problems.push("the export should carry the tab's one URL, got " + report.findings.length);
  }
  if (!report.findings.every((f) => f.url && f.lastSeen && f.cache)) {
    problems.push("the export dropped fields");
  }
  // A header value is server-controlled, so it must never become markup.
  const hostileText = await render(tabHolding(snapshot, "hostile.js"));
  const injected = await popup.eval('document.querySelectorAll("#findings script").length');
  const executed = await popup.eval('window.__pwned === undefined ? "no" : "yes"');
  if (injected !== 0) problems.push("a header value injected a script element into the popup");
  if (executed !== "no") problems.push("a header value executed script in the popup");
  if (!hostileText.includes("<script>")) {
    problems.push("the hostile header value was not rendered as literal text");
  }

  popup.close();
  return problems;
}

// The skip log answers "I loaded the URL that should be vulnerable and nothing
// showed up -- why?". A known-safe asset has to appear there, with its reason.
async function runSkipLogScenario(session, origin) {
  const problems = [];

  await session.visit(origin + "/static-app.js", 2000);

  const skipsByTab = JSON.parse(
    await session.worker.eval("JSON.stringify(recentSkips)", true)
  );
  const tabId = Object.keys(skipsByTab).find((id) =>
    (skipsByTab[id] || []).some((skip) => skip.url.endsWith("/static-app.js"))
  );
  if (!tabId) return ["an ordinary .js asset never appeared in the skip log"];

  const entry = skipsByTab[tabId].find((skip) => skip.url.endsWith("/static-app.js"));
  if (entry.reason !== "not-document") {
    problems.push("expected reason not-document, got " + entry.reason);
  }
  if (entry.detail !== "text/javascript") {
    problems.push("expected the real content type to be recorded, got " + entry.detail);
  }

  // The popup has to render it, or the diagnostic only exists in devtools.
  await session.browser.send("Target.createTarget", { url: session.popupUrl });
  await sleep(1500);
  const popupTarget = (await session.list()).find((t) => t.url === session.popupUrl);
  const popup = await CDP.connect(popupTarget.webSocketDebuggerUrl);

  const response = await popup.eval(
    `new Promise(r => chrome.runtime.sendMessage({type:"GET_SKIPS",tabId:${tabId}}, resp => r(JSON.stringify(resp))))`,
    true
  );
  await popup.eval(`renderSkips(${JSON.stringify(JSON.parse(response).skips)})`);
  await popup.eval(`document.getElementById("toggle-skips").click()`);

  const text = await popup.eval(`document.getElementById("skips").innerText`);
  if (!text.includes("/static-app.js")) {
    problems.push("the popup did not list the rejected URL");
  }
  if (!text.includes("served as text/javascript, not a document")) {
    problems.push("the popup did not explain why the request was not flagged");
  }

  // The skip log renders network-supplied values too, so it gets the same test.
  await popup.eval(
    `renderSkips([{url:"http://example.com/<img src=x onerror=1>.js",reason:"not-document",detail:null}])`
  );
  const skipInjected = await popup.eval(
    'document.querySelectorAll("#skips img, #skips script").length'
  );
  if (skipInjected !== 0) problems.push("a skip entry injected markup into the popup");

  // A reason with no wording falls through to the raw string, which would
  // make the log unreadable exactly when it is needed.
  for (const reason of ["no-body", "matches-url"]) {
    const wording = await popup.eval(
      `skipReasonText(${JSON.stringify(reason)}, "application/json")`
    );
    if (wording === reason) problems.push("the popup has no wording for " + reason);
  }

  popup.close();
  return problems;
}

// The lab shape: a static *directory* cache rule, which the detector ignores on
// purpose because the URL looks nothing like a file. The readout is what makes
// it visible: load once, reload, and the second load is served from cache.
async function runDocumentScenario(session, origin) {
  const problems = [];
  const url = origin + "/resources/private";

  await session.visit(url, 1800);

  const page = (await session.list()).find((t) => t.url === url);
  if (!page) return ["the page load target never opened"];
  const pageConn = await CDP.connect(page.webSocketDebuggerUrl);
  await pageConn.send("Page.reload");
  await sleep(2200);
  pageConn.close();

  const byTab = JSON.parse(
    await session.worker.eval("JSON.stringify(recentDocuments)", true)
  );
  const tabId = Object.keys(byTab).find((id) =>
    (byTab[id] || []).some((load) => load.url.endsWith("/resources/private"))
  );
  if (!tabId) return ["the page load was never recorded"];

  const loads = byTab[tabId].filter((load) => load.url.endsWith("/resources/private"));
  if (loads.length < 2) problems.push("both visits should be kept, got " + loads.length);
  if (!(loads[0].sharedCacheEvidence || []).length) {
    problems.push("the second load should be reported as served from cache");
  }
  if (loads[0].contentType !== "text/html") {
    problems.push("the content type was not recorded, got " + loads[0].contentType);
  }
  if (!loads[0].hasSessionCookie) problems.push("the session cookie was not recorded");

  // It must not be a finding: a bare directory path is exactly what the
  // detector ignores, which is why the readout has to exist.
  const findings = await session.snapshot();
  if ((findings[tabId] || []).some((f) => f.url.endsWith("/resources/private"))) {
    problems.push("a bare directory path must not be flagged");
  }

  await session.browser.send("Target.createTarget", { url: session.popupUrl });
  await sleep(1500);
  const popupTarget = (await session.list()).find((t) => t.url === session.popupUrl);
  const popup = await CDP.connect(popupTarget.webSocketDebuggerUrl);

  const response = await popup.eval(
    `new Promise(r => chrome.runtime.sendMessage({type:"GET_DOCUMENTS",tabId:${tabId}}, resp => r(JSON.stringify(resp))))`,
    true
  );
  await popup.eval(`renderDocuments(${JSON.stringify(JSON.parse(response).documents)})`);

  const text = await popup.eval('document.getElementById("documents").innerText');
  if (!text.includes("/resources/private")) problems.push("the popup did not list the page load");
  if (!text.includes("from cache")) problems.push("the popup did not report the cache hit");
  if (!text.includes("x-cache: HIT")) problems.push("the popup did not show the cache evidence");

  popup.close();
  return problems;
}

async function runPersistenceScenario(session, origin) {
  const problems = [];

  // getBadgeText reads back empty in headless after a reload, so record the
  // values the extension actually sets instead of asking for them back.
  await session.worker.eval(
    `(() => {
       globalThis.__badges = [];
       const original = chrome.action.setBadgeText.bind(chrome.action);
       chrome.action.setBadgeText = (options) => {
         globalThis.__badges.push(options);
         return original(options);
       };
       return "wrapped";
     })()`,
    false
  );

  await session.visit(origin + "/persist-target.js", 2200);

  const before = await session.snapshot();
  const tabId = tabHolding(before, "persist-target.js");
  if (!tabId) return ["the persistence target was never flagged"];

  const badges = JSON.parse(
    await session.worker.eval("JSON.stringify(globalThis.__badges)", true)
  );
  const ourBadges = badges.filter((b) => b.tabId === Number(tabId));
  if (!ourBadges.length || ourBadges.some((b) => b.text !== "1")) {
    problems.push(
      `badge should count distinct URLs (always "1"), got ${JSON.stringify(ourBadges.map((b) => b.text))}`
    );
  }

  // Destroy the worker. An attached debugger session keeps it alive, so drop
  // every connection to it first.
  session.worker.close();
  await session.browser.send("Target.closeTarget", { targetId: session.workerTarget.id });

  let stopped = false;
  for (let attempt = 0; attempt < 20 && !stopped; attempt++) {
    await sleep(500);
    stopped = !(await session.list()).some(
      (t) => t.type === "service_worker" && t.url.endsWith("/background.js")
    );
  }
  if (!stopped) return ["could not terminate the service worker, so persistence was not exercised"];

  // Opening the popup wakes a fresh worker.
  await session.browser.send("Target.createTarget", { url: session.popupUrl });
  await sleep(2500);

  const revivedTarget = (await session.list()).find(
    (t) => t.type === "service_worker" && t.url.endsWith("/background.js")
  );
  if (!revivedTarget) return ["the service worker never came back"];
  if (revivedTarget.id === session.workerTarget.id) {
    problems.push("the worker was not actually replaced, so persistence was not proven");
  }

  const revived = await CDP.connect(revivedTarget.webSocketDebuggerUrl);
  const restored = JSON.parse(
    await revived.eval("hydrated.then(() => JSON.stringify(findingsByTab))", true)
  );
  if (!restored[tabId] || !restored[tabId].length) {
    problems.push("findings did not survive the service worker restart");
  }
  revived.close();
  return problems;
}

// --- runner -----------------------------------------------------------------

async function main() {
  if (typeof WebSocket === "undefined") {
    console.error("This suite needs Node 22 or newer (for the global WebSocket).");
    process.exit(1);
  }

  const chromePath = findChrome();
  if (!chromePath) {
    console.log("SKIP: no Chrome found. Set CHROME_PATH to run the browser tests.");
    return 0;
  }
  console.log("chrome:", chromePath);

  const site = await fixtures.start();
  const cdpPort = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-sentry-e2e-"));
  let chrome;
  let failures = 0;

  try {
    chrome = await launch(chromePath, profileDir, cdpPort);
    const session = await openSession(cdpPort);
    console.log("extension loaded:", session.extensionId, "\nsite:", site.origin, "\n");

    await session.visit(site.origin + "/setcookie", 1600);

    const scenarios = [
      ...pathScenarios.map((scenario) => ({
        name: scenario.name,
        run: () => runPathScenario(session, site.origin, scenario),
      })),
      { name: "popup collapses repeats and explains the finding", run: () => runPopupScenario(session, site.origin) },
      { name: "the skip log explains why a safe request was ignored", run: () => runSkipLogScenario(session, site.origin) },
      { name: "the page load readout shows a static directory being cached", run: () => runDocumentScenario(session, site.origin) },
      { name: "findings survive a service worker restart", run: () => runPersistenceScenario(session, site.origin) },
    ];

    for (const scenario of scenarios) {
      const problems = await scenario.run();
      if (problems.length === 0) {
        console.log("PASS  " + scenario.name);
      } else {
        failures += 1;
        console.log("FAIL  " + scenario.name);
        for (const problem of problems) console.log("        " + problem);
      }
    }
  } finally {
    closeAll();
    killTree(chrome);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
    site.server.close();
  }

  console.log("\n" + (failures ? failures + " scenario(s) failed" : "all scenarios passed"));
  return failures ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("FATAL:", error.message);
    process.exitCode = 1;
  });