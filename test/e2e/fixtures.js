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
  const server = http.createServer((req, res) => {
    const route = ROUTES[req.url.split("?")[0]];
    const { status, headers, body } = route
      ? route()
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