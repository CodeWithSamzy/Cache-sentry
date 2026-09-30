#!/usr/bin/env node
// Captures the screenshots used by the README.
//
// These are not mockups: a real headless Chrome loads the real extension from
// this repository, the frames are rendered by the popup's own code, and the
// data comes out of the service worker. The site, however, is the local fixture
// server, so nothing here is a real target -- the captions say so.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CDP } = require("../test/e2e/cdp");
const fixtures = require("../test/e2e/fixtures");
const {
  findChrome,
  freePort,
  killTree,
  launch,
  openSession,
  openPopup,
  loadPopupForTab,
  sleep,
} = require("../test/e2e/harness");

const OUT_DIR = path.join(__dirname, "..", "docs", "screenshots");
// A fixed port and hostname so the captured URLs read like a site rather
// than like whichever ephemeral port the test run happened to get.
const SITE_PORT = 8080;
const ORIGIN = "http://localhost:" + SITE_PORT;
const POPUP_WIDTH = 340;
const CAPTURE_SCALE = 2;

// Realistic-looking URLs for the response shapes the browser tests already use,
// so a screenshot reads like a real site instead of like a test fixture.
// Merged into the fixture routes before the server starts.
const DEMO_ROUTES = {
  // The deception shape: a private page under an asset URL.
  "/my-account/profile.js": () => ({
    status: 200,
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "public, max-age=120",
      "X-Cache": "HIT",
    },
    body:
      "<h1>Your account</h1>" +
      '<script>for (let i = 0; i < 3; i += 1) fetch("/account/settings.css", { cache: "no-store" });</script>',
  }),

  // Fetched three times by the page above, which is what a collapsed count
  // looks like in the popup.
  "/account/settings.css": () => ({
    status: 200,
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "public, max-age=300",
      Age: "9",
      "X-Cache": "HIT",
    },
    body: "<h1>Your account</h1>",
  }),

  // An ordinary stylesheet: suspicious-looking URL, correct response type.
  "/assets/theme.js": () => ({
    status: 200,
    headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=31536000" },
    body: "console.log(1)\n",
  }),

  // Answers with a document, but tells caches to keep a copy per user.
  "/account/summary.js": () => ({
    status: 200,
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "public, max-age=60",
      Vary: "Cookie",
    },
    body: "<h1>Your account</h1>",
  }),
};

const state = async (session, expression) =>
  JSON.parse(await session.worker.eval("JSON.stringify(" + expression + ")", true));

async function tabHolding(session, expression, suffix) {
  const byTab = await state(session, expression);
  const tabId = Object.keys(byTab).find((id) =>
    (byTab[id] || []).some((entry) => entry.url.endsWith(suffix))
  );
  if (!tabId) throw new Error("no tab recorded " + suffix + " in " + expression);
  return tabId;
}

async function capture(session, name, tabId, { openSkips = false } = {}) {
  const popup = await openPopup(session);
  try {
    await popup.send("Emulation.setDeviceMetricsOverride", {
      width: POPUP_WIDTH,
      height: 1400,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const seen = await loadPopupForTab(popup, tabId);
    if (openSkips) await popup.eval('document.getElementById("toggle-skips").click()');
    await sleep(250);

    const height = Math.ceil(await popup.eval("document.body.getBoundingClientRect().height"));
    const shot = await popup.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: POPUP_WIDTH, height, scale: CAPTURE_SCALE },
    });

    const file = path.join(OUT_DIR, name + ".png");
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log(
      name + ".png  " +
      POPUP_WIDTH + "x" + height + " css, " + (POPUP_WIDTH * CAPTURE_SCALE) + "px wide  " +
      seen.findings.findings.length + " finding(s), " +
      seen.documents.documents.length + " page load(s), " +
      seen.skips.skips.length + " skip(s)"
    );
  } finally {
    popup.close();
  }
}

// Visits several URLs in one tab. Findings reset on navigation but the skip
// log does not, so this is the only way to show more than one rejected
// request at a time.
async function visitSameTab(session, urls, settleMs = 1800) {
  await session.browser.send("Target.createTarget", { url: urls[0] });
  await sleep(settleMs);
  const target = (await session.list()).find((t) => t.url === urls[0]);
  if (!target) throw new Error("the tab never opened " + urls[0]);
  const conn = await CDP.connect(target.webSocketDebuggerUrl);
  try {
    for (const next of urls.slice(1)) {
      await conn.send("Page.navigate", { url: next });
      await sleep(settleMs);
    }
  } finally {
    conn.close();
  }
}

async function main() {
  if (typeof WebSocket === "undefined") {
    console.error("This needs Node 22 or newer (for the global WebSocket).");
    process.exit(1);
  }

  const chromePath = findChrome();
  if (!chromePath) {
    console.error("No Chrome found. Set CHROME_PATH to run this.");
    process.exit(1);
  }

  Object.assign(fixtures.ROUTES, DEMO_ROUTES);

  const site = await fixtures.start(SITE_PORT);
  const cdpPort = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-sentry-shots-"));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let chrome;

  try {
    chrome = await launch(chromePath, profileDir, cdpPort);
    const session = await openSession(cdpPort);
    console.log("extension:", session.extensionId, "\nfixture site:", ORIGIN, "\n");

    await session.visit(ORIGIN + "/setcookie", 1600);

    // 1. A private document served from an asset URL, plus a repeat finding.
    await session.visit(ORIGIN + "/my-account/profile.js", 2400);
    await capture(session, "popup-finding", await tabHolding(session, "findingsByTab", "/my-account/profile.js"));

    // 2. A static directory rule: load once, reload, and the second load is
    //    served from cache. The detector stays quiet here on purpose.
    const dashboard = ORIGIN + "/resources/dashboard";
    await session.visit(dashboard, 1800);
    const page = (await session.list()).find((target) => target.url === dashboard);
    if (!page) throw new Error("the page load target never opened");
    const pageConn = await CDP.connect(page.webSocketDebuggerUrl);
    await pageConn.send("Page.reload");
    await sleep(2200);
    pageConn.close();
    await capture(session, "popup-page-loads", await tabHolding(session, "recentDocuments", "/resources/dashboard"));

    // 3. Two requests that look suspicious and were rejected, with the reason.
    await visitSameTab(session, [
      ORIGIN + "/assets/theme.js",
      ORIGIN + "/account/summary.js",
    ]);
    await capture(
      session,
      "popup-skipped-requests",
      await tabHolding(session, "recentSkips", "/account/summary.js"),
      { openSkips: true }
    );
  } finally {
    killTree(chrome);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
    site.server.close();
  }
}

main().catch((error) => {
  console.error("FATAL:", error.message);
  process.exitCode = 1;
});