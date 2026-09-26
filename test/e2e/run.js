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
    name: "a document under an asset URL flags; ordinary assets do not",
    paths: {
      "/deception.js": true,
      "/static-app.js": false,
      "/asset.png": false,
      "/no-store.js": false,
      "/plain.html": false,
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