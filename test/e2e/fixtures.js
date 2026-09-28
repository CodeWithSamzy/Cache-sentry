// The site the test browser visits. Each route is exactly one response shape,
// so a scenario reads as "this URL with these headers must / must not be
// flagged". Nothing here is a real vulnerability: the point is the shape.
const http = require("node:http");

const CACHEABLE = { "Cache-Control": "public, max-age=60" };

const document_ = (extra = {}) => ({
  status: 200,
  headers: { "Content-Type": "text/html", ...CACHEABLE, ...extra },
  body: "<h1>private page</h1>",
});

const ROUTES = {
  "/setcookie": () => ({
    status: 200,
    headers: { "Set-Cookie": "session=abc123; Path=/", "Content-Type": "text/html" },
    body: "<h1>cookie set</h1>",
  }),

  // The deception shape: a private document under an asset-looking URL.
  "/deception.js": () => document_({ "X-Cache": "HIT" }),
  "/popup-target.js": () => document_({ "X-Cache": "HIT" }),
  "/persist-target.js": () => document_({ "X-Cache": "HIT" }),

  // Ordinary static assets: the noise the heuristics have to ignore.
  "/static-app.js": () => ({
    status: 200,
    headers: {
      "Content-Type": "text/javascript",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
    body: "console.log(1)\n",
  }),
  "/asset.png": () => ({
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
    body: "png bytes",
  }),

  // A JSON API call: the URL promises JSON and gets JSON, so there is no
  // contradiction even though a session cookie rode along (the x.com shape).
  "/api/me.json": () => ({
    status: 200,
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      ...CACHEABLE,
      "cf-cache-status": "DYNAMIC",
    },
    body: "{\"ok\":true}",
  }),

  // Gates that must still suppress.
  "/no-store.js": () => ({
    status: 200,
    headers: { "Content-Type": "text/html", "Cache-Control": "no-store, private" },
    body: "<h1>private</h1>",
  }),
  "/plain.html": () => document_(),

  // Vary: only the credential-keyed forms should suppress.
  "/vary-cookie.js": () => document_({ Vary: "Cookie" }),
  "/vary-star.js": () => document_({ Vary: "*" }),
  "/vary-encoding.js": () => document_({ Vary: "Accept-Encoding" }),

  // A server trying to smuggle markup through a header value.
  "/hostile.js": () => ({
    status: 200,
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "public, max-age=60<script>window.__pwned=1</script>",
    },
    body: "<h1>hostile</h1>",
  }),
};

function start() {
  // Requests under a static directory behave like a CDN with a static
  // directory cache rule: the first one misses and is stored, later ones are
  // served from cache. This is the shape the detector cannot see, because the
  // URL looks nothing like a file.
  const hits = new Map();

  const staticDirectory = (path) => {
    if (!path.startsWith("/resources/")) return null;
    const count = (hits.get(path) || 0) + 1;
    hits.set(path, count);
    return {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "public, max-age=60",
        Age: String(count - 1),
        "X-Cache": count === 1 ? "miss" : "HIT",
      },
      body: "<h1>private page</h1>",
    };
  };

  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    const response = staticDirectory(path) || (ROUTES[path] ? ROUTES[path]() : null);
    const { status, headers, body } = response
      ? response
      : { status: 404, headers: { "Content-Type": "text/plain" }, body: "not found" };
    res.writeHead(status, headers);
    res.end(body);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, origin: "http://127.0.0.1:" + port });
    });
  });
}

module.exports = { start, ROUTES };