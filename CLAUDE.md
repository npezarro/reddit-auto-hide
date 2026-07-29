# Reddit Auto-Hide

Tampermonkey userscript that hides scrolled-past Reddit posts, plus `reddit-hide-sync`, a small
Express service that stores the hidden-post set so it survives reloads and syncs across devices.

**This is a PUBLIC repo.** No domains, VM usernames, deploy paths, IPs, or API keys in committed
files. The sync endpoint and key are runtime config (Tampermonkey storage / `.env`), never
literals. A pre-commit hook enforces this; do not `--no-verify` around it.

## Layout

| Path | Role |
|---|---|
| `reddit-auto-hide.user.js` | The userscript. Version bump required on every change. |
| `server.js` | Express app: auth, routing, validation. |
| `lib/store.js` | JSON-backed hidden-post store: delta queries, tombstones, pruning, atomic writes. |
| `test/store.test.js` | `node:test` unit tests for the store. |
| `test/integration.mjs` | Real userscript in Chromium against a real server. Needs `SYNC_BASE` + `SYNC_KEY`. |
| `ecosystem.config.cjs` | PM2 config. No `cwd` field: start it from the repo directory. |

## Commands

```bash
npm install
npm run build   # syntax check (no bundler)
npm test        # store unit tests, all must pass before commit
npm start       # server on 127.0.0.1:$PORT

# End-to-end: hide by scrolling, reload, assert still hidden, then cross-device.
# Run this after ANY change to the ledger, sync, or visual-state code.
SYNC_BASE=<base> SYNC_KEY=<key> node test/integration.mjs
```

The integration test is the only thing that catches the v2.4 class of bug, because
"hidden posts come back on the next load" looks identical to success from inside a
single page life. Two traps in its harness, both already handled: Playwright's
`exposeFunction` is always async while `GM_getValue` is called at module scope (so
the store is inlined into the init script and only writes go through a binding),
and the userscript must be injected *after* load rather than via `addInitScript`
because it declares `@run-at document-idle` (injecting at document-start makes
`GM_addStyle` throw on a null `document.head`).

## Architecture: three tiers of persistence

Ordered by how much you can trust them. This ordering is the whole point of v3.0 and must not be
inverted.

1. **Local ledger** (`GM_setValue`, key `ledgerV3`) — written first and synchronously durable.
   Shape: `{hidden: {id: {t, remote, reddit, tries}}, tombs: {id: {t, remote}}, lastPull}`.
   This alone is what decides whether a post is suppressed on screen.
2. **Sync server** — cross-device source of truth, delta-pulled via a `since` cursor.
3. **Reddit `/api/hide`** — best effort only, so Reddit's own feed filters as well.

### Invariants

- **Never mark something synced before the server confirms it.** The v2.4 bug was dequeuing ids
  before the API call, so any failure silently dropped the hide. Flags (`remote`, `reddit`) are set
  only in a success branch.
- **Never let a queue live only in memory.** Queues are *derived* from ledger flags
  (`idsNeeding('remote')`), so they reconstruct themselves after a reload. Do not add a standalone
  in-memory `Set` of pending work.
- **Tombstones, not deletions.** An unhide of a server-known id writes `ledger.tombs[id]` and
  `DELETE /api/hidden`. Dropping the row instead would let another device's push re-hide it.
  A local unhide beats an older server "hidden" row during a pull, or the unhide bounces back.
- **Adds are monotonic server-side.** Re-adding an existing id must not bump its timestamp,
  otherwise every device's push resurfaces every id in every other device's delta forever.
- **Fail soft.** No network, no key, or a 500 must never block hiding: the local ledger carries it
  and the queue retries.

## Gotchas

- `getPostId` must return a Reddit link fullname (`t3_<base36>`); the server rejects anything else.
  Comment fullnames (`t1_`) and bare ids are invalid.
- Session-hidden posts fade (0.15 opacity); ledger-restored posts collapse (`display:none`). Both
  go through `setVisual`/`refreshVisuals`, not inline styles, so Reddit's own inline styles survive.
- The sync loop runs on every Reddit page; observers and the UI only run on feed pages (`feedMode`).
  `applyLedgerToPosts` is feed-gated, or it would collapse the post you just clicked into.
- Mobile Firefox needs the `unsafeWindow` auth interception and the scroll fallback;
  IntersectionObserver exit events are unreliable there and CSP can block injected `<script>` tags.
- `@connect *` is deliberate: the endpoint is user-configured, so the host is unknown at publish
  time. Tampermonkey prompts once per host.

## Deploy

Server: see README (`ProxyPass` a path prefix, set `BASE_PATH`, `pm2 start ecosystem.config.cjs`,
`pm2 save`). Real host, port, and key live in `privateContext/reddit-hide-sync-env.md`.

Userscript: bump `@version`, then sync via the TM script deploy in the browser-agent repo (source
map + install-page version both need updating).

## The bug class this repo exists to prevent

**A feature that delegates durability to a fire-and-forget remote write works
perfectly inside one page life and silently forgets everything on the next load.**
Reported by users as "works in a given tab session but isn't reliably on next
fetch" -- that phrasing is diagnostic: in-session correctness plus cross-session
loss means the in-memory path is fine and the durability path is missing. Do not
start by debugging the hide logic.

The v2.4 shape, for reference:

    batch.forEach(id => pending.delete(id));    // dequeued FIRST
    for (const id of batch) await hidePost(id); // then attempted

Auth-not-yet-captured, 401, 429, timeout, or navigation each dropped the item
permanently while the UI still counted it. A startup race guaranteed the first
few: the drain timer fired at t=2s, the auth probe at t=1s/5s.

The invariants above are the fix. Two extra notes that live here rather than in
the invariants:

- **Delta cursors must only advance past rows actually returned.** On a truncated
  page, `nextSince` is the timestamp of the last row sent, not "now".
- **Every API response sends `Cache-Control: no-store`.** The production host sits
  behind a CDN with an edge cache; a cached delta response hands the client a
  stale cursor and silently drops everything in between. Verify with
  `curl -sD -`: the cache-status header must never say `HIT`.

Full cross-cutting write-up, including the rules for any component whose
durability depends on an outbound call: knowledgeBase
`patterns/remote-api-is-not-persistence.md`.
