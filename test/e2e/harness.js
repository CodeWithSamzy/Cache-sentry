// Shared Chrome plumbing for the browser tests and the screenshot tool: find a
// binary, start it headless with a throwaway profile, load the extension, and
// attach over CDP.
//
// Chrome 137+ branded builds ignore --load-extension and
// --disable-extensions-except, so the extension is loaded over CDP with
// Extensions.loadUnpacked instead. That needs --enable-unsafe-extension-debugging.
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const { CDP } = require("./cdp");

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

// The extension's popup as its own page. In a real browser it is a popup
// anchored to the toolbar, so opened like this it cannot work out which tab it
// belongs to; callers pass a tab id to the worker instead of relying on that.
async function openPopup(session, settleMs = 1500) {
  await session.browser.send("Target.createTarget", { url: session.popupUrl });
  await sleep(settleMs);
  const target = (await session.list()).find((t) => t.url === session.popupUrl);
  if (!target) throw new Error("the popup page never opened");
  return CDP.connect(target.webSocketDebuggerUrl);
}

// Asks the worker for one tab's state and renders it into the popup, exactly as
// the popup would for its own tab.
async function loadPopupForTab(popup, tabId) {
  const ask = (type) =>
    popup.eval(
      "new Promise(r => chrome.runtime.sendMessage({type:" +
        JSON.stringify(type) +
        ",tabId:" +
        JSON.stringify(tabId) +
        "}, resp => r(JSON.stringify(resp))))",
      true
    );

  const findings = JSON.parse(await ask("GET_FINDINGS"));
  const documents = JSON.parse(await ask("GET_DOCUMENTS"));
  const skips = JSON.parse(await ask("GET_SKIPS"));

  await popup.eval("render(" + JSON.stringify(findings.findings) + ")");
  await popup.eval("renderDocuments(" + JSON.stringify(documents.documents) + ")");
  await popup.eval("renderSkips(" + JSON.stringify(skips.skips) + ")");

  return { findings, documents, skips };
}

module.exports = {
  EXTENSION_DIR,
  sleep,
  findChrome,
  freePort,
  launch,
  killTree,
  openSession,
  openPopup,
  loadPopupForTab,
};