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
   `;jsessionid=` form is excluded). Only the path is examined, so a `%2f%2f`
   or a `.js` inside a query value is treated as ordinary data.
3. **The response contradicts the URL**: it comes back as a document or data
   payload (`text/html`, `text/plain`, JSON, XML) instead of the asset type the
   URL claims. This is the part that matters. `/static/app.js` answering with
   JavaScript is an ordinary asset and is never flagged, while
   `/my-account/x.js` answering with HTML is the real cache deception shape.
   The comparison is real: `/api/user.json` answering with JSON, and a `.js.map`
   answering with JSON, are what those URLs promise and are not flagged.
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
5. Check **Page loads** to see what the cache did with the documents this tab
   fetched, including plain directory paths the detector leaves alone
6. Click **Export findings (JSON)** to save this tab's findings as a report you
   can attach to a ticket or a write-up

Findings are held in `chrome.storage.session`, so they survive the extension's
service worker being shut down (Chrome stops it after ~30 seconds idle) and are
cleared when the browser closes. The rejected-request log described below is
not persisted: it is a debugging aid, not a finding.

## When nothing is flagged

"Nothing showed up" is ambiguous. Either no suspicious-looking URL was seen at
all, or one was seen and a check threw it away. The popup's **Why nothing
flagged?** section lists the requests that looked suspicious and were then
dropped, with the reason:

| Reason | What it means |
| --- | --- |
| `no-session-cookie` | the request sent no session cookie, so there was nothing private to leak |
| `not-document` | the response really was the asset type the URL claimed (e.g. `text/javascript`) |
| `no-body` | the response has no body at all (a `304` revalidation), so its `Content-Type` means nothing |
| `matches-url` | the response type is what the URL already claims, so nothing is contradicted |
| `varies-on-credentials` | the response varies on `Cookie`/`Authorization`, so each user gets their own copy |
| `not-cacheable` | no shared cache would keep it (`no-store`, `private`, or no cache headers at all) |

So if you load a URL that should be vulnerable and get nothing, open this
section first. If the URL is not in that list either, then no request carrying
a session cookie was made for it in that tab.

## Is this URL actually cached?

The detector only analyses URLs that look like static files, so a static
*directory* path (`/resources/anything`, no file extension) is invisible to it
even while a cache is storing it. The popup's **Page loads** section covers that
gap, because it records every main document this tab fetched rather than only
the suspicious-looking ones.

| What the readout shows | What it means |
| --- | --- |
| `no cache hit` | no `Age` or hit marker, so this load was not served from a shared cache |
| `from cache` with `age: 7 · x-cache: HIT` | a shared cache served this response |

Load a URL, then load it again. Both entries stay in the list, so a first visit
that misses and a second that hits is visible as a change between them. That is
the passive answer to "does this URL get cached?" -- it reports requests Chrome
already made and never sends one of its own.

If Chrome's own HTTP cache answers instead of the network, no new entry is
recorded. Change the path or add a query string to force a real fetch.

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
- the diagnostic log: a known-safe asset has to show up as `not-document`, both
  in the worker's state and in the popup, and a hostile value must not become
  markup
- the page-load readout against a real static-directory cache rule: the first
  load misses, the reload is reported as `from cache`, and the URL is correctly
  *not* turned into a finding

It starts a fixture server on an ephemeral port, launches Chrome with a
throwaway profile, and loads the extension over CDP. Set `CHROME_PATH` if Chrome
is not in a standard location; the suite prints a SKIP message if it cannot find
one.

Chrome 137+ branded builds ignore `--load-extension` and
`--disable-extensions-except`, so the extension is loaded with
`Extensions.loadUnpacked`, which requires `--enable-unsafe-extension-debugging`.

## Known limitations

- Trusts `Vary` as implemented. A response varying on `Cookie` or
  `Authorization` is treated as not exploitable, which is correct for a cache
  that honours it -- but caches that ignore or mishandle `Vary` do exist, and
  those are not flagged.
- A response with no `Content-Type`, or one sent as
  `application/octet-stream`, is not treated as a contradiction, so a
  genuinely mislabelled asset is missed rather than guessed at.
- A static directory path with no file extension is never turned into a finding,
  even when a cache is storing it. **Page loads** shows it instead, which keeps
  the finding list clear of the false positives that shape would otherwise
  produce.
- A cached JSON API is out of scope by design. Once the URL and the response
  type agree (`.json` answering with JSON) there is nothing to contradict, and
  headers alone cannot tell a public config endpoint from a private one. Such a
  response only shows up in **Page loads**.
- Everything here is a heuristic over response headers. It is checked against a
  fixture server and the unit suite, but not yet against a live vulnerable
  target, so treat the first real-world run as a calibration exercise.

## Deliberately not built

- A "test the variants for me" button. Firing delimiter-trick requests from the
  extension would turn observing traffic into probing a target, and it can cache
  the user's own authenticated page in a shared cache -- the exact harm this
  tool exists to report. The tool stays passive on purpose.

## Next steps

- Validate against a PortSwigger Web Cache Deception lab, and write down what
  the real headers look like so the heuristics can be tuned to them
- Turn the readout into a verdict: when a URL that `Vary`s on a credential is
  still served `from cache`, say so outright instead of leaving it to be read
- Screenshots of the popup for the store listing

## Privacy

No data leaves the browser. Findings live in `chrome.storage.session` and are
gone when the browser closes. `PRIVACY.md` has the full policy.

## License

MIT -- see `LICENSE`.
