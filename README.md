# Cache Sentry

A passive Chrome extension that flags potential **web cache deception**
signals while you browse — no active exploitation, just observation of
response headers on requests that carry a session cookie.

## What it detects

A request is flagged when **all** of these are true:

1. The request carried a real session cookie. Requests whose only cookies are
   known analytics or bot cookies (`_ga`, `_fbp`, `__cf_bm`, ...) do not
   count, since they are not authenticated traffic.
2. The URL looks like a static asset (`.css`, `.js`, `.png`, ...) or carries a
   delimiter that makes caches and origins disagree about it (`%2e%2e`,
   `%2f%2f`, `%00`, `%23`, `%3f`, or a `;` path parameter -- the benign
   `;jsessionid=` form is excluded).
3. **The response contradicts the URL**: it comes back as a document or data
   payload (`text/html`, `text/plain`, JSON, XML) instead of the asset type the
   URL claims. This is the part that matters. `/static/app.js` answering with
   JavaScript is an ordinary asset and is never flagged, while
   `/my-account/x.js` answering with HTML is the real cache deception shape.
4. The response carries cache-related headers (`Cache-Control` without
   `no-store`/`private`, `Age`, `X-Cache`, or `CF-Cache-Status`).
5. The response does not vary on credentials. A `Vary` naming `Cookie` or
   `Authorization` (or `Vary: *`) means the cache keeps a separate entry per
   user, so there is nothing for it to hand to the next visitor.

This is a **signal, not proof** -- always verify manually (e.g. with curl
or Burp) before treating a flagged request as a real vulnerability.

## Install (unpacked, for development)

1. Open Chrome and go to `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select this folder (`cache-sentry`)
5. The extension icon should appear in your toolbar

## How to use it

1. Browse normally, or navigate to a site you're authorized to test
2. If a suspicious request/response is seen, the toolbar icon shows a badge
   count
3. Click the icon to see each flagged URL, what the response did to
   contradict it (`a text/html response came back for a .js URL`), and which
   cache headers were present. Repeat hits on the same URL collapse into one
   row with a ×N count, and the badge counts distinct URLs rather than hits
4. Findings reset when you navigate to a new page (per-tab)

Findings are held in `chrome.storage.session`, so they survive the extension's
service worker being shut down (Chrome stops it after ~30 seconds idle) and are
cleared when the browser closes.

## Testing it against a known-vulnerable pattern

PortSwigger's Web Security Academy labs on Web Cache Deception are a safe,
legal place to test this — load a lab, log in, and browse to a path like
`/my-account/nonexistent.js` to see if it gets flagged.

## Tests

```
npm test          # unit suite, no browser required
npm run test:e2e  # browser suite, needs Chrome
npm run test:all  # both
```

**`npm test`** loads `background.js` in a Node VM with a stubbed `chrome` API
and drives real request/response pairs through it. It covers the happy path,
every gate that suppresses a finding, per-tab isolation and cleanup, the
persistence behaviour, and the known false positives written as explicit tests
so heuristic changes surface as failures instead of silent drift.

**`npm run test:e2e`** drives a real headless Chrome, because some things a stub
cannot reproduce:

- the order Chrome actually delivers `webNavigation` and `webRequest` events,
  which is what made a blanket reset on navigation erase the finding for the
  very page being loaded
- the real service worker lifecycle, so persistence is proven by destroying the
  worker and reviving it rather than by trusting that a storage call happened
- the popup's rendered DOM, including that a header value cannot inject markup

It starts a fixture server on an ephemeral port, launches Chrome with a
throwaway profile, and loads the extension over CDP. Set `CHROME_PATH` if Chrome
is not in a standard location; the suite prints a SKIP message if it cannot find
one.

Chrome 137+ branded builds ignore `--load-extension` and
`--disable-extensions-except`, so the extension is loaded with
`Extensions.loadUnpacked`, which requires `--enable-unsafe-extension-debugging`.

## Known limitations (v1)

- Trusts `Vary` as implemented. A response varying on `Cookie` or
  `Authorization` is treated as not exploitable, which is correct for a cache
  that honours it -- but caches that ignore or mishandle `Vary` do exist, and
  those are not flagged.
- A response with no `Content-Type`, or one sent as
  `application/octet-stream`, is not treated as a contradiction, so a
  genuinely mislabelled asset is missed rather than guessed at.
- Doesn't test URL normalization variants automatically yet (planned v2: a
  button to fire safe variant requests and diff cache behavior)

## Next steps (v2 ideas)

- Add a "test variants" button: fire safe passive requests with delimiter
  tricks and diff the `Cache-Control`/`X-Cache` response between them
- Parse `Vary` header to reduce false positives
- Export findings as a JSON report