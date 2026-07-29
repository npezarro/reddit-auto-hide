# Reddit Auto-Hide

A Tampermonkey userscript that hides Reddit posts once you have scrolled past them, plus a small
self-hosted sync server so those hides survive reloads and follow you between devices.

## Why the server exists

Version 2.4 kept no durable record of what it had hidden. Everything lived in in-memory JS
collections, so each page load started from zero, and persistence was delegated entirely to
Reddit's `/api/hide` endpoint on a fire-and-forget basis. If the auth token had not been captured
yet, or the call returned 401/429, or you navigated away before the queue drained, the hide was
lost while the UI still reported success. Result: hiding appeared to work inside a tab session but
did not survive the next fetch.

v3.0 inverts the ownership:

1. **Local ledger (Tampermonkey storage)** — written first, synchronously durable. This is what
   suppresses posts on screen, so a hide survives reload even with no network.
2. **Sync server (this repo)** — the cross-device source of truth. Pulled on load and on an
   interval, pushed as posts are hidden. Nothing is marked synced until the server confirms, so a
   failed push retries on the next tick or the next session instead of disappearing.
3. **Reddit's native hide** — still called, best effort, so Reddit's own feed filters too. If it
   fails permanently the post stays hidden by (1) and (2) anyway.

## Server

Express, no database, no native dependencies. State is a single JSON file written atomically
through a serialized write chain.

```bash
npm install
cp .env.example .env       # then set API_KEY (openssl rand -hex 32)
npm start                  # listens on 127.0.0.1:$PORT
npm test                   # store unit tests
npm run build              # syntax check
```

### API

`Authorization: Bearer <API_KEY>` on everything except `/api/health`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness + live count. No auth. |
| `GET` | `/api/hidden?since=<epochMs>&limit=<n>` | Delta since a cursor. Returns `{hidden, deleted, nextSince, truncated}`. `since=0` returns everything. |
| `POST` | `/api/hidden` | Body `{ids:[...]}`. Adds hides. Idempotent, and re-adding does not bump an existing timestamp. |
| `DELETE` | `/api/hidden` | Body `{ids:[...]}` or `{all:true}`. Writes tombstones so unhides propagate. |
| `GET` | `/api/stats` | Live count, tombstone count, oldest/newest timestamps. |

Ids must be Reddit link fullnames (`t3_<base36>`); anything else is rejected and counted in the
response so a client bug surfaces instead of silently no-oping.

**Tombstones matter.** Deleting an id records it as deleted rather than dropping the row. Without
that, unhiding on device A would just be re-hidden by device B's next push. Tombstones are pruned
after 90 days.

### Deploy

Reverse-proxy a path prefix to the port and set `BASE_PATH` to that prefix (the app strips it):

```apache
ProxyPass        /reddit-hide http://127.0.0.1:3205
ProxyPassReverse /reddit-hide http://127.0.0.1:3205
```

```bash
npm ci --omit=dev
pm2 start ecosystem.config.cjs && pm2 save
curl -s https://example.com/reddit-hide/api/health
```

## Userscript

Install `reddit-auto-hide.user.js` in Tampermonkey, then use the Tampermonkey menu on any Reddit
page:

| Menu command | What it does |
|---|---|
| **Auto-Hide: configure sync** | Prompts for the server base URL and API key, then verifies both against `/api/health` and an authenticated read before reporting success. |
| **Auto-Hide: setup link for another device** | Copies a one-time `#autohide-sync=...` link. Open it on a second device and sync configures itself. |
| **Auto-Hide: sync now** | Forces a push, pull, and Reddit-hide drain. |
| **Auto-Hide: status** | Hidden count, queue depths, whether the key is set, whether Reddit auth was captured, last pull cursor. |
| **Auto-Hide: forget all hidden posts** | Unhides everything, everywhere. Confirms first. |

The endpoint and key are stored per device in Tampermonkey storage and are deliberately **not**
baked into the script, which is published publicly for auto-update. With no key configured the
script still works: hides persist locally and via Reddit's own hide API, just not across devices.

### Setting up a second device

Typing a 64-character key into a mobile Tampermonkey prompt is miserable, so any Reddit URL
carrying `#autohide-sync=<base64 of "https://host/base|key">` configures sync on load and strips
the fragment from history immediately. Use **setup link for another device** on an
already-configured device to generate it. The link contains the key, so send it privately; it stays
in that device's history for the moment before `replaceState` clears it.

On-page controls (bottom right): toggle auto-hide, temporarily reveal hidden posts, and unhide the
hidden posts on the current page.

### Behaviour notes

- Posts hidden during the current page life fade to 15% opacity so you can see it happen. On any
  later load they are collapsed outright (`display: none`), which is what "hidden" should mean.
- The sync loop runs on every Reddit page, not just feeds, so a queue left over from a fast scroll
  still flushes if you click into a comment thread.
- The ledger is flushed to storage on `pagehide` and on `visibilitychange`, so closing the tab
  mid-queue does not lose anything: unsynced entries are retried on the next load.
- Rate limiting (HTTP 429) from Reddit pauses native hides for 60s; a 401/403 drops the captured
  token and re-probes. Neither affects local or server-side hiding.
- A post whose native hide fails 8 times stops being retried and is left hidden locally and on the
  server.
