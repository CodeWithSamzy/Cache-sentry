# Cache Sentry privacy policy

Cache Sentry runs entirely inside your browser. It has no server, and it does
not send anything anywhere.

## What it sees

- The URL, request headers, and response headers of network requests, so it can
  spot a request that carries a session cookie and gets a cacheable response for
  a URL that looks like a static file.
- It does not read page content, form fields, keystrokes, or passwords.

## What it stores, and where

- Findings are held in memory and in `chrome.storage.session`, which Chrome
  keeps for the life of the browser session and clears when the browser closes.
- The rejected-request log and the recent page-load readout are held in memory
  only.
- Nothing is written to `chrome.storage.local` or `chrome.storage.sync`, so
  nothing is synced to your Google account.
- Nothing is uploaded. There is no analytics, no telemetry, and no remote code.

## What you control

- Findings are per tab. Closing a tab clears its findings, and everything is
  gone when the browser closes.
- Uninstalling the extension removes the stored data with it.
- The JSON export is written by you, to a file you choose; the extension does
  not transmit it.

## Permissions and why they are needed

- `webRequest` -- to read request and response headers.
- `webNavigation` -- to reset a tab's findings when it navigates somewhere new.
- `storage` -- to keep findings alive across Chrome's service-worker restarts.
- `<all_urls>` host access -- a cache deception bug can exist on any site, so
  the check cannot be limited to a short list of domains.

## Contact

Open an issue at https://github.com/CodeWithSamzy/Cache-sentry/issues