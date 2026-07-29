// ==UserScript==
// @name         Reddit Auto-Hide Seen Posts
// @namespace    https://github.com/npezarro/scripts
// @version      3.2
// @description  Automatically hides Reddit posts after you scroll past them. Keeps a durable local ledger plus an optional authenticated sync server, so hides survive reloads and follow you across devices.
// @author       npezarro
// @match        *://*.reddit.com/*
// @exclude      *://www.reddit.com/api/*
// @exclude      *://mod.reddit.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      oauth.reddit.com
// @connect      *
// @run-at       document-idle
// @updateURL    https://gist.githubusercontent.com/npezarro/a15e7b64beb7c746509be820fa0d07c6/raw/reddit-auto-hide.user.js
// @downloadURL  https://gist.githubusercontent.com/npezarro/a15e7b64beb7c746509be820fa0d07c6/raw/reddit-auto-hide.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --- Config ---
  const SCROLL_PAST_DELAY_MS = 500;
  const SYNC_TICK_MS = 2000;          // how often the outbound queues drain
  const PULL_INTERVAL_MS = 120000;    // how often we pull other devices' hides
  const REDDIT_BATCH = 5;             // Reddit hide calls per tick (rate-limit friendly)
  const REMOTE_BATCH = 500;           // ids per sync request (server caps at 500)
  const MAX_REDDIT_TRIES = 8;         // give up on the native hide, keep hiding locally
  const RATE_LIMIT_PAUSE_MS = 60000;
  const AUTH_PROBE_INTERVAL_MS = 30000;  // network probe floor when logged out

  // Sync server is configured per device (Tampermonkey menu -> "Auto-Hide: configure
  // sync"), never hardcoded here: this file is published for auto-update.
  const LEDGER_KEY = 'ledgerV3';
  const SYNC_KEY_NAME = 'syncKey';
  const SYNC_BASE_NAME = 'syncBase';
  const LEDGER_MAX_ENTRIES = 20000;
  const LEDGER_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

  // --- State ---
  let enabled = GM_getValue('autoHideEnabled', true);
  let showHidden = false;
  let feedMode = false;               // observers/UI only run on feed pages
  const seenTimers = new Map();       // postId -> timeout handle
  const seenInViewport = new Set();   // posts that entered the viewport at least once
  const onPage = new Map();           // postId -> element, for posts we are suppressing
  const sessionFaded = new Set();     // hidden during THIS page life -> fade, not collapse
  let observer = null;
  let mutationObserver = null;
  let countDisplay = null;
  let syncInterval = null;
  let redditRateLimitedUntil = 0;
  let lastPullAttempt = 0;
  let pulling = false;
  let pushing = false;

  // The durable record. `hidden` is what we suppress; `tombs` are unhides still
  // waiting to be pushed so they do not come back from another device.
  let ledger = { hidden: {}, tombs: {}, lastPull: 0 };

  // --- Logging via page console (visible to browser-logs) ---
  const pageLog = unsafeWindow.console.log.bind(unsafeWindow.console);
  const pageWarn = unsafeWindow.console.warn.bind(unsafeWindow.console);

  // ============================================================
  // Durable ledger
  // ============================================================

  function loadLedger() {
    let raw = null;
    try {
      raw = JSON.parse(GM_getValue(LEDGER_KEY, 'null'));
    } catch (e) {
      pageWarn('[AutoHide] Ledger unreadable, starting fresh: ' + e.message);
    }
    const next = { hidden: {}, tombs: {}, lastPull: 0 };
    if (!raw || typeof raw !== 'object') return next;

    next.lastPull = Number(raw.lastPull) || 0;
    const cutoff = Date.now() - LEDGER_MAX_AGE_MS;
    const hidden = raw.hidden && typeof raw.hidden === 'object' ? raw.hidden : {};
    const ids = Object.keys(hidden)
      .filter((id) => hidden[id] && Number(hidden[id].t) > cutoff)
      .sort((a, b) => hidden[b].t - hidden[a].t)
      .slice(0, LEDGER_MAX_ENTRIES);
    for (const id of ids) {
      const e = hidden[id];
      next.hidden[id] = { t: Number(e.t) || 0, remote: e.remote ? 1 : 0, reddit: e.reddit ? 1 : 0, tries: Number(e.tries) || 0 };
    }
    const tombs = raw.tombs && typeof raw.tombs === 'object' ? raw.tombs : {};
    for (const id of Object.keys(tombs)) {
      const e = tombs[id];
      if (e && Number(e.t) > cutoff) next.tombs[id] = { t: Number(e.t) || 0, remote: e.remote ? 1 : 0 };
    }

    const dropped = Object.keys(hidden).length - ids.length;
    if (dropped > 0) pageLog(`[AutoHide] Ledger pruned ${dropped} stale entries`);
    return next;
  }

  let saveTimer = null;

  function saveLedgerNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      GM_setValue(LEDGER_KEY, JSON.stringify(ledger));
    } catch (e) {
      pageWarn('[AutoHide] Ledger save failed: ' + e.message);
    }
  }

  function saveLedgerSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveLedgerNow();
    }, 500);
  }

  function recordHidden(postId, opts) {
    const o = opts || {};
    const existing = ledger.hidden[postId];
    delete ledger.tombs[postId];
    ledger.hidden[postId] = {
      t: existing ? existing.t : Date.now(),
      remote: o.remote ? 1 : (existing ? existing.remote : 0),
      reddit: o.reddit ? 1 : (existing ? existing.reddit : 0),
      tries: existing ? existing.tries : 0,
    };
    saveLedgerSoon();
  }

  function recordUnhidden(postId) {
    const wasSynced = ledger.hidden[postId] && ledger.hidden[postId].remote;
    delete ledger.hidden[postId];
    sessionFaded.delete(postId);
    // Only tombstone what the server actually knows about; anything never pushed
    // can just disappear locally.
    if (wasSynced) ledger.tombs[postId] = { t: Date.now(), remote: 0 };
    saveLedgerSoon();
  }

  function idsNeeding(field) {
    const out = [];
    for (const id in ledger.hidden) {
      if (!ledger.hidden[id][field]) out.push(id);
    }
    return out;
  }

  function pendingTombIds() {
    const out = [];
    for (const id in ledger.tombs) {
      if (!ledger.tombs[id].remote) out.push(id);
    }
    return out;
  }

  function hiddenCount() {
    return Object.keys(ledger.hidden).length;
  }

  // ============================================================
  // Reddit DOM
  // ============================================================

  function isOldReddit() {
    return location.hostname === 'old.reddit.com' ||
      document.querySelector('#siteTable') !== null;
  }

  function getPostId(el) {
    if (el.tagName === 'SHREDDIT-POST') {
      const id = el.getAttribute('id');
      if (id && id.startsWith('t3_')) return id;
      const permalink = el.getAttribute('permalink') || el.getAttribute('content-href') || '';
      const match = permalink.match(/\/comments\/([a-z0-9]+)/);
      if (match) return 't3_' + match[1];
    }

    const fullname = el.getAttribute('data-fullname');
    if (fullname) return fullname;

    const link = el.querySelector('a[href*="/comments/"]');
    if (link) {
      const match = link.href.match(/\/comments\/([a-z0-9]+)/);
      if (match) return 't3_' + match[1];
    }

    return null;
  }

  function getPostElements() {
    if (isOldReddit()) {
      return document.querySelectorAll('#siteTable > .thing.link');
    }
    const shredditPosts = document.querySelectorAll('shreddit-post');
    if (shredditPosts.length > 0) return shredditPosts;
    return document.querySelectorAll('article[data-testid="post-container"]');
  }

  // ============================================================
  // Visual state
  // ============================================================

  function setVisual(el, mode) {
    el.classList.remove('ah-collapsed', 'ah-faded');
    if (mode === 'collapsed') el.classList.add('ah-collapsed');
    else if (mode === 'faded') el.classList.add('ah-faded');
  }

  function refreshVisuals() {
    for (const [id, el] of onPage) {
      if (!el.isConnected) {
        onPage.delete(id);
        continue;
      }
      if (showHidden || !ledger.hidden[id]) setVisual(el, 'revealed');
      else setVisual(el, sessionFaded.has(id) ? 'faded' : 'collapsed');
    }
  }

  /**
   * Suppress any post on the page that the ledger already knows about. Runs on
   * load and on every infinite-scroll batch, so a hide made on another device
   * (or in a previous session) takes effect without touching Reddit's API.
   */
  function applyLedgerToPosts() {
    if (!feedMode) return 0;
    let applied = 0;
    for (const post of getPostElements()) {
      const postId = getPostId(post);
      if (!postId || !ledger.hidden[postId]) continue;
      if (onPage.get(postId) === post) continue;
      onPage.set(postId, post);
      if (!showHidden) setVisual(post, sessionFaded.has(postId) ? 'faded' : 'collapsed');
      applied++;
    }
    if (applied > 0) {
      pageLog(`[AutoHide] Suppressed ${applied} already-hidden post(s) from ledger`);
      updateCount();
    }
    return applied;
  }

  function updateCount() {
    if (!countDisplay) return;
    const total = hiddenCount();
    const queued = idsNeeding('remote').length + pendingTombIds().length;
    countDisplay.textContent = queued > 0 ? `${total} hidden (${queued} syncing)` : `${total} hidden`;
    const key = GM_getValue(SYNC_KEY_NAME, '');
    countDisplay.title = key
      ? `${total} hidden locally, ${queued} awaiting server sync, ${idsNeeding('reddit').length} awaiting Reddit hide`
      : 'Cross-device sync is OFF. Use the Tampermonkey menu: "Auto-Hide: configure sync".';
  }

  function fadePost(postId, el) {
    sessionFaded.add(postId);
    onPage.set(postId, el);
    recordHidden(postId);
    setVisual(el, 'faded');
    updateCount();
    pageLog(`[AutoHide] Hid ${postId} (${hiddenCount()} total)`);
  }

  // ============================================================
  // Auth capture (Reddit's own bearer token, for the native hide API)
  // ============================================================

  let capturedHeaders = null;

  function captureAuth(headers) {
    capturedHeaders = headers;
    pageLog('[AutoHide] Captured auth: ' + Object.keys(headers).join(', '));
  }

  function extractHeaders(h) {
    if (!h) return null;
    const captured = {};
    try {
      if (h instanceof unsafeWindow.Headers || (h.forEach && h.get)) {
        h.forEach(function (v, k) { captured[k.toLowerCase()] = v; });
      } else if (typeof h === 'object' && !Array.isArray(h)) {
        for (const k in h) { if (Object.prototype.hasOwnProperty.call(h, k)) captured[k.toLowerCase()] = h[k]; }
      }
    } catch (e) { /* not a headers-shaped thing */ }
    return captured['authorization'] ? captured : null;
  }

  try {
    const win = unsafeWindow;

    const origFetch = win.fetch.bind(win);
    win.fetch = function (input, init) {
      try {
        let found = extractHeaders(init && init.headers);
        if (!found && input && typeof input === 'object' && input.headers) {
          found = extractHeaders(input.headers);
        }
        if (found) captureAuth(found);
      } catch (e) { /* never break the page's fetch */ }
      return origFetch.apply(win, arguments);
    };

    const origOpen = win.XMLHttpRequest.prototype.open;
    const origSetHeader = win.XMLHttpRequest.prototype.setRequestHeader;
    const origSend = win.XMLHttpRequest.prototype.send;

    win.XMLHttpRequest.prototype.open = function () {
      this.__ahHeaders = {};
      return origOpen.apply(this, arguments);
    };
    win.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (this.__ahHeaders) this.__ahHeaders[name.toLowerCase()] = value;
      return origSetHeader.apply(this, arguments);
    };
    win.XMLHttpRequest.prototype.send = function () {
      if (this.__ahHeaders && this.__ahHeaders['authorization']) {
        captureAuth(this.__ahHeaders);
      }
      return origSend.apply(this, arguments);
    };

    pageLog('[AutoHide] Auth interceptors installed via unsafeWindow');
  } catch (e) {
    pageWarn('[AutoHide] Failed to install auth interceptors: ' + e.message);
  }

  let lastAuthProbeAt = 0;

  function probeForAuth() {
    if (capturedHeaders) return;
    // The cheap in-page lookups are free, so always try those first.
    try {
      const cfg = unsafeWindow.__r;
      if (cfg && cfg.config && cfg.config.accessToken) {
        captureAuth({ 'authorization': `Bearer ${cfg.config.accessToken}` });
        return;
      }
    } catch (e) { /* not old reddit */ }
    try {
      for (const s of document.querySelectorAll('script')) {
        const text = s.textContent;
        if (text && text.includes('accessToken')) {
          const match = text.match(/"accessToken"\s*:\s*"([^"]+)"/);
          if (match) {
            captureAuth({ 'authorization': `Bearer ${match[1]}` });
            return;
          }
        }
      }
    } catch (e) { /* no inline token */ }

    // The network probe is throttled: the sync loop calls this on every tick
    // while the Reddit queue is non-empty, and a logged-out session would
    // otherwise fire a request every couple of seconds forever.
    const now = Date.now();
    if (now - lastAuthProbeAt < AUTH_PROBE_INTERVAL_MS) return;
    lastAuthProbeAt = now;
    try {
      unsafeWindow.fetch('https://www.reddit.com/svc/shreddit/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'me' }),
      }).catch(() => {});
      pageLog('[AutoHide] Probed for auth via graphql endpoint');
    } catch (e) { /* probe is best effort */ }
  }

  // ============================================================
  // HTTP
  // ============================================================

  function gmFetch(url, method, headers, body) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: body,
        timeout: 15000,
        onload: (r) => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText }),
        onerror: (e) => resolve({ ok: false, status: 0, text: `Network error: ${(e && e.error) || 'unknown'}` }),
        ontimeout: () => resolve({ ok: false, status: 0, text: 'Timeout' }),
      });
    });
  }

  // ============================================================
  // Sync server (cross-device source of truth)
  // ============================================================

  function syncKey() {
    return GM_getValue(SYNC_KEY_NAME, '');
  }

  function syncBase() {
    return GM_getValue(SYNC_BASE_NAME, '').replace(/\/$/, '');
  }

  function syncHeaders() {
    return {
      'Authorization': `Bearer ${syncKey()}`,
      'Content-Type': 'application/json',
    };
  }

  let syncKeyWarned = false;

  /**
   * One-time provisioning from a link: any Reddit URL with
   * `#autohide-sync=<base64 of "https://host/base|key">`.
   * Typing a 64-character key into a mobile Tampermonkey prompt is miserable;
   * opening a link is not. The fragment is stripped from history immediately.
   */
  function consumeSyncLink() {
    const match = location.hash.match(/[#&]autohide-sync=([^&]+)/);
    if (!match) return false;

    let decoded = '';
    try {
      decoded = unsafeWindow.atob(decodeURIComponent(match[1]));
    } catch (e) {
      pageWarn('[AutoHide] Sync link is not valid base64, ignoring');
      return false;
    }
    const sep = decoded.lastIndexOf('|');
    if (sep < 1) {
      pageWarn('[AutoHide] Sync link must decode to "<baseUrl>|<key>"');
      return false;
    }
    const base = decoded.slice(0, sep).trim().replace(/\/$/, '');
    const key = decoded.slice(sep + 1).trim();
    if (!/^https?:\/\//.test(base) || !key) {
      pageWarn('[AutoHide] Sync link missing a valid base URL or key');
      return false;
    }

    GM_setValue(SYNC_BASE_NAME, base);
    GM_setValue(SYNC_KEY_NAME, key);
    syncKeyWarned = false;

    // Do not leave the key sitting in the URL bar or this history entry.
    try {
      const clean = location.href.replace(/[#&]autohide-sync=[^&]*/, '');
      unsafeWindow.history.replaceState(null, '', clean || location.pathname);
    } catch (e) { /* cosmetic only */ }

    pageLog('[AutoHide] Sync configured from link: ' + base);
    return true;
  }

  function syncEnabled() {
    if (syncKey() && syncBase()) return true;
    if (!syncKeyWarned) {
      syncKeyWarned = true;
      pageWarn('[AutoHide] Cross-device sync is off (no endpoint/key). Hides still persist on this device. Tampermonkey menu -> "Auto-Hide: configure sync".');
    }
    return false;
  }

  /** Pull everything other devices changed since our cursor. */
  async function pullRemote(force) {
    if (!syncEnabled() || pulling) return;
    const now = Date.now();
    if (!force && now - lastPullAttempt < PULL_INTERVAL_MS) return;
    lastPullAttempt = now;
    pulling = true;
    try {
      let guard = 0;
      let more = true;
      let added = 0;
      let removed = 0;
      while (more && guard < 20) {
        guard++;
        const url = `${syncBase()}/api/hidden?since=${ledger.lastPull}&limit=5000`;
        const resp = await gmFetch(url, 'GET', syncHeaders());
        if (!resp.ok) {
          pageWarn(`[AutoHide] Pull failed (${resp.status}): ${String(resp.text).slice(0, 160)}`);
          return;
        }
        let data;
        try {
          data = JSON.parse(resp.text);
        } catch (e) {
          pageWarn('[AutoHide] Pull returned non-JSON (proxy or auth page?): ' + String(resp.text).slice(0, 120));
          return;
        }

        for (const entry of data.hidden || []) {
          const id = entry && entry.id;
          if (!id) continue;
          // A local unhide we have not pushed yet must win over the server's
          // older "hidden" row, or the unhide would bounce straight back.
          const tomb = ledger.tombs[id];
          if (tomb && !tomb.remote && tomb.t >= Number(entry.t || 0)) continue;
          if (ledger.hidden[id]) {
            ledger.hidden[id].remote = 1;
            continue;
          }
          // Already hidden on the device that pushed it, so skip the Reddit call.
          ledger.hidden[id] = { t: Number(entry.t) || Date.now(), remote: 1, reddit: 1, tries: 0 };
          added++;
        }

        for (const id of data.deleted || []) {
          if (ledger.hidden[id]) {
            delete ledger.hidden[id];
            sessionFaded.delete(id);
            removed++;
          }
          delete ledger.tombs[id];
        }

        ledger.lastPull = Number(data.nextSince) || ledger.lastPull;
        more = Boolean(data.truncated);
      }

      saveLedgerNow();
      if (added || removed) {
        pageLog(`[AutoHide] Pulled from sync server: +${added} hidden, -${removed} unhidden`);
        applyLedgerToPosts();
        refreshVisuals();
      }
      updateCount();
    } finally {
      pulling = false;
    }
  }

  /** Push local hides and unhides. Nothing is marked synced until the server confirms. */
  async function pushRemote() {
    if (!syncEnabled() || pushing) return;
    pushing = true;
    try {
      const toAdd = idsNeeding('remote').slice(0, REMOTE_BATCH);
      if (toAdd.length) {
        const resp = await gmFetch(`${syncBase()}/api/hidden`, 'POST', syncHeaders(), JSON.stringify({ ids: toAdd }));
        if (resp.ok) {
          for (const id of toAdd) {
            if (ledger.hidden[id]) ledger.hidden[id].remote = 1;
          }
          saveLedgerNow();
          pageLog(`[AutoHide] Pushed ${toAdd.length} hide(s) to sync server`);
        } else {
          pageWarn(`[AutoHide] Push failed (${resp.status}): ${String(resp.text).slice(0, 160)} — will retry`);
        }
      }

      const toDelete = pendingTombIds().slice(0, REMOTE_BATCH);
      if (toDelete.length) {
        const resp = await gmFetch(`${syncBase()}/api/hidden`, 'DELETE', syncHeaders(), JSON.stringify({ ids: toDelete }));
        if (resp.ok) {
          for (const id of toDelete) delete ledger.tombs[id];
          saveLedgerNow();
          pageLog(`[AutoHide] Pushed ${toDelete.length} unhide(s) to sync server`);
        } else {
          pageWarn(`[AutoHide] Unhide push failed (${resp.status}) — will retry`);
        }
      }
      updateCount();
    } finally {
      pushing = false;
    }
  }

  // ============================================================
  // Reddit's native hide (best effort, so Reddit's own feed filters too)
  // ============================================================

  async function redditHide(id) {
    const auth = capturedHeaders;
    if (!auth || !auth['authorization']) return { ok: false, status: -1 };
    return gmFetch('https://oauth.reddit.com/api/hide', 'POST', {
      'Authorization': auth['authorization'],
      'Content-Type': 'application/x-www-form-urlencoded',
    }, `id=${id}`);
  }

  async function redditUnhide(id) {
    const auth = capturedHeaders;
    if (!auth || !auth['authorization']) return { ok: false, status: -1 };
    return gmFetch('https://oauth.reddit.com/api/unhide', 'POST', {
      'Authorization': auth['authorization'],
      'Content-Type': 'application/x-www-form-urlencoded',
    }, `id=${id}`);
  }

  async function drainRedditQueue() {
    const queue = idsNeeding('reddit');
    if (queue.length === 0) return;
    if (Date.now() < redditRateLimitedUntil) return;

    if (!capturedHeaders || !capturedHeaders['authorization']) {
      probeForAuth();
      return; // keep the queue intact; the ledger already hides these locally
    }

    for (const id of queue.slice(0, REDDIT_BATCH)) {
      const entry = ledger.hidden[id];
      if (!entry) continue;
      const resp = await redditHide(id);
      if (resp.ok) {
        entry.reddit = 1;
        continue;
      }
      if (resp.status === 429) {
        redditRateLimitedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
        pageWarn('[AutoHide] Reddit rate limited; pausing native hides for 60s');
        break;
      }
      if (resp.status === 401 || resp.status === 403) {
        capturedHeaders = null; // token rotated; re-capture and retry later
        probeForAuth();
        break;
      }
      entry.tries = (entry.tries || 0) + 1;
      if (entry.tries >= MAX_REDDIT_TRIES) {
        entry.reddit = 1; // stop retrying; local + server still hide it
        pageWarn(`[AutoHide] Giving up on Reddit-side hide for ${id} after ${entry.tries} tries (still hidden locally and synced)`);
      }
    }
    saveLedgerSoon();
    updateCount();
  }

  function startSyncLoop() {
    if (syncInterval) return;
    syncInterval = setInterval(async () => {
      await pushRemote();
      await pullRemote(false);
      await drainRedditQueue();
    }, SYNC_TICK_MS);
  }

  // ============================================================
  // Scroll detection
  // ============================================================

  function findScrollRoot() {
    const firstPost = document.querySelector('shreddit-post, article[data-testid="post-container"], #siteTable > .thing.link');
    if (!firstPost) return null;
    let el = firstPost.parentElement;
    const candidates = [];
    while (el && el !== document.body && el !== document.documentElement) {
      const style = getComputedStyle(el);
      const overflow = style.overflowY;
      candidates.push(`<${el.tagName.toLowerCase()}> overflow-y=${overflow} scrollH=${el.scrollHeight} clientH=${el.clientHeight}`);
      if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && el.scrollHeight > el.clientHeight) {
        return el;
      }
      el = el.parentElement;
    }
    pageLog(`[AutoHide] No scroll container found. Ancestors: ${candidates.join(' -> ')}`);
    return null; // viewport is the scroll root
  }

  function setupObserver() {
    if (observer) observer.disconnect();

    const scrollRoot = findScrollRoot();
    if (scrollRoot) {
      pageLog(`[AutoHide] Using scroll container: <${scrollRoot.tagName.toLowerCase()}>`);
    }

    observer = new IntersectionObserver((entries) => {
      if (!enabled || showHidden) return;

      for (const entry of entries) {
        const postId = getPostId(entry.target);
        if (!postId || ledger.hidden[postId]) continue;

        if (entry.isIntersecting) {
          seenInViewport.add(postId);
          if (seenTimers.has(postId)) {
            clearTimeout(seenTimers.get(postId));
            seenTimers.delete(postId);
          }
        } else if (seenInViewport.has(postId) && !seenTimers.has(postId)) {
          const rect = entry.boundingClientRect;
          if (rect.bottom < 0 || (scrollRoot && rect.bottom < scrollRoot.getBoundingClientRect().top)) {
            const el = entry.target;
            seenTimers.set(postId, setTimeout(() => {
              seenTimers.delete(postId);
              fadePost(postId, el);
            }, SCROLL_PAST_DELAY_MS));
          }
        }
      }
    }, {
      root: scrollRoot,
      threshold: [0, 0.1],
      rootMargin: '0px',
    });

    observeAllPosts();
  }

  function observeAllPosts() {
    if (!observer) return;
    applyLedgerToPosts();
    for (const post of getPostElements()) {
      const postId = getPostId(post);
      if (postId && ledger.hidden[postId]) continue;
      if (!post.dataset.autoHideObserved) {
        observer.observe(post);
        post.dataset.autoHideObserved = 'true';
      }
    }
  }

  // Some mobile browsers (Firefox Android) do not fire reliable exit events.
  function setupScrollFallback() {
    let lastCheck = 0;

    function checkScrolledPast() {
      if (!enabled || showHidden) return;
      const now = Date.now();
      if (now - lastCheck < 300) return;
      lastCheck = now;

      for (const post of getPostElements()) {
        const postId = getPostId(post);
        if (!postId || ledger.hidden[postId]) continue;

        const rect = post.getBoundingClientRect();
        if (rect.bottom < 0) {
          if (!seenTimers.has(postId)) {
            seenInViewport.add(postId);
            seenTimers.set(postId, setTimeout(() => {
              seenTimers.delete(postId);
              fadePost(postId, post);
            }, SCROLL_PAST_DELAY_MS));
          }
        } else if (rect.top < window.innerHeight && rect.bottom > 0) {
          seenInViewport.add(postId);
          if (seenTimers.has(postId)) {
            clearTimeout(seenTimers.get(postId));
            seenTimers.delete(postId);
          }
        }
      }
    }

    window.addEventListener('scroll', checkScrolledPast, { passive: true });
    pageLog('[AutoHide] Scroll fallback listener installed');
  }

  function setupMutationObserver() {
    if (mutationObserver) mutationObserver.disconnect();

    mutationObserver = new MutationObserver(() => {
      observeAllPosts();
    });

    const feedContainer = isOldReddit()
      ? document.querySelector('#siteTable')
      : document.querySelector('shreddit-feed, [data-testid="posts-list"], main');

    mutationObserver.observe(feedContainer || document.body, { childList: true, subtree: true });
  }

  // ============================================================
  // UI
  // ============================================================

  function createToggleUI() {
    const container = document.createElement('div');
    container.id = 'auto-hide-toggle';

    const enableBtn = document.createElement('button');
    enableBtn.id = 'auto-hide-enable-btn';
    enableBtn.textContent = enabled ? 'Auto-Hide: ON' : 'Auto-Hide: OFF';
    enableBtn.title = 'Toggle auto-hiding of seen posts';
    enableBtn.addEventListener('click', () => {
      enabled = !enabled;
      GM_setValue('autoHideEnabled', enabled);
      enableBtn.textContent = enabled ? 'Auto-Hide: ON' : 'Auto-Hide: OFF';
      enableBtn.classList.toggle('disabled', !enabled);
    });
    if (!enabled) enableBtn.classList.add('disabled');

    const showBtn = document.createElement('button');
    showBtn.id = 'auto-hide-show-btn';
    showBtn.textContent = 'Show Hidden';
    showBtn.title = 'Temporarily reveal hidden posts on this page';
    showBtn.addEventListener('click', () => {
      showHidden = !showHidden;
      showBtn.textContent = showHidden ? 'Resume Hiding' : 'Show Hidden';
      showBtn.classList.toggle('active', showHidden);
      refreshVisuals();
    });

    const unhideBtn = document.createElement('button');
    unhideBtn.id = 'auto-hide-unhide-btn';
    unhideBtn.textContent = 'Unhide Page';
    unhideBtn.title = 'Unhide the hidden posts on this page everywhere: locally, on the sync server, and on Reddit';
    unhideBtn.addEventListener('click', async () => {
      const ids = Array.from(onPage.keys()).filter((id) => ledger.hidden[id]);
      if (ids.length === 0) return;
      unhideBtn.textContent = 'Unhiding...';

      const redditSynced = ids.filter((id) => ledger.hidden[id].reddit);
      for (const id of ids) recordUnhidden(id);
      saveLedgerNow();
      refreshVisuals();
      updateCount();

      for (const id of redditSynced) await redditUnhide(id);
      await pushRemote();

      unhideBtn.textContent = 'Unhide Page';
      showHidden = false;
      showBtn.textContent = 'Show Hidden';
      showBtn.classList.remove('active');
      pageLog(`[AutoHide] Unhid ${ids.length} post(s)`);
    });

    countDisplay = document.createElement('span');
    countDisplay.id = 'auto-hide-count';
    countDisplay.textContent = '0 hidden';

    container.appendChild(enableBtn);
    container.appendChild(showBtn);
    container.appendChild(unhideBtn);
    container.appendChild(countDisplay);
    document.body.appendChild(container);
    updateCount();
  }

  GM_addStyle(`
    .ah-collapsed { display: none !important; }
    .ah-faded { opacity: 0.15 !important; transition: opacity 0.3s; }

    #auto-hide-toggle {
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 99999;
      display: flex;
      gap: 6px;
      align-items: center;
      background: #1a1a1b;
      border: 1px solid #343536;
      border-radius: 8px;
      padding: 6px 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      transition: opacity 0.2s;
    }

    #auto-hide-toggle:hover { opacity: 1 !important; }

    #auto-hide-toggle button {
      background: #272729;
      color: #d7dadc;
      border: 1px solid #474748;
      border-radius: 4px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
      transition: background 0.15s;
    }

    #auto-hide-toggle button:hover { background: #3a3a3c; }

    #auto-hide-enable-btn {
      background: #0079d3 !important;
      border-color: #0079d3 !important;
      color: #fff !important;
    }

    #auto-hide-enable-btn.disabled {
      background: #474748 !important;
      border-color: #474748 !important;
      color: #818384 !important;
    }

    #auto-hide-show-btn.active {
      background: #ff4500 !important;
      border-color: #ff4500 !important;
      color: #fff !important;
    }

    #auto-hide-count {
      color: #818384;
      padding: 0 4px;
      white-space: nowrap;
    }

    @media (prefers-color-scheme: light) {
      #auto-hide-toggle {
        background: #ffffff;
        border-color: #edeff1;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      }
      #auto-hide-toggle button {
        background: #f6f7f8;
        color: #1c1c1c;
        border-color: #edeff1;
      }
      #auto-hide-toggle button:hover { background: #e8e8e8; }
      #auto-hide-count { color: #7c7c7c; }
    }

    #auto-hide-toggle:not(:hover) #auto-hide-show-btn,
    #auto-hide-toggle:not(:hover) #auto-hide-unhide-btn {
      display: none;
    }
  `);

  // ============================================================
  // Menu commands
  // ============================================================

  function registerMenu() {
    GM_registerMenuCommand('Auto-Hide: configure sync', async () => {
      const base = unsafeWindow.prompt(
        'Sync server base URL, e.g. https://example.com/reddit-hide\nLeave blank to turn cross-device sync off (hides still persist on this device).',
        syncBase()
      );
      if (base === null) return;
      const cleanBase = base.trim().replace(/\/$/, '');
      GM_setValue(SYNC_BASE_NAME, cleanBase);
      if (!cleanBase) {
        GM_setValue(SYNC_KEY_NAME, '');
        pageLog('[AutoHide] Cross-device sync disabled');
        updateCount();
        return;
      }

      const key = unsafeWindow.prompt('API key for ' + cleanBase + ' (sent as a Bearer token)', syncKey());
      if (key === null) return;
      GM_setValue(SYNC_KEY_NAME, key.trim());
      syncKeyWarned = false;
      updateCount();

      // Prove the credentials work now rather than failing silently later.
      const health = await gmFetch(`${cleanBase}/api/health`, 'GET', {});
      if (!health.ok) {
        unsafeWindow.alert(`Saved, but ${cleanBase}/api/health returned ${health.status || 'no response'}.\nCheck the URL and that the server is reachable.`);
        return;
      }
      const probe = await gmFetch(`${cleanBase}/api/hidden?since=0&limit=1`, 'GET', syncHeaders());
      if (!probe.ok) {
        unsafeWindow.alert(`Server is up but rejected the key (HTTP ${probe.status}).\nRe-run "configure sync" with the correct key.`);
        return;
      }
      await pullRemote(true);
      await pushRemote();
      unsafeWindow.alert(`Sync connected to ${cleanBase}.\n${hiddenCount()} hidden posts known on this device.`);
    });

    GM_registerMenuCommand('Auto-Hide: setup link for another device', () => {
      if (!syncBase() || !syncKey()) {
        unsafeWindow.alert('Configure sync on this device first.');
        return;
      }
      const payload = unsafeWindow.btoa(`${syncBase()}|${syncKey()}`);
      const link = `https://www.reddit.com/#autohide-sync=${encodeURIComponent(payload)}`;
      try {
        GM_setClipboard(link);
        unsafeWindow.alert('Setup link copied to the clipboard.\n\nOpen it on another device that has this script installed. It configures sync and removes itself from the URL.\n\nIt contains your key: send it privately.');
      } catch (e) {
        unsafeWindow.prompt('Open this on the other device (contains your key, send it privately):', link);
      }
    });

    GM_registerMenuCommand('Auto-Hide: sync now', async () => {
      await pushRemote();
      await pullRemote(true);
      await drainRedditQueue();
      unsafeWindow.alert(`Auto-Hide sync done.\n${hiddenCount()} hidden, ${idsNeeding('remote').length} still queued for the sync server.`);
    });

    GM_registerMenuCommand('Auto-Hide: status', () => {
      const msg = [
        `Hidden posts: ${hiddenCount()}`,
        `Queued for sync server: ${idsNeeding('remote').length} adds, ${pendingTombIds().length} removes`,
        `Queued for Reddit hide: ${idsNeeding('reddit').length}`,
        `Sync key: ${syncKey() ? 'set' : 'NOT SET (device-local only)'}`,
        `Reddit auth: ${capturedHeaders ? 'captured' : 'not captured yet'}`,
        `Last pull cursor: ${ledger.lastPull ? new Date(ledger.lastPull).toLocaleString() : 'never'}`,
      ].join('\n');
      pageLog('[AutoHide] ' + msg.replace(/\n/g, ' | '));
      unsafeWindow.alert(msg);
    });

    GM_registerMenuCommand('Auto-Hide: forget all hidden posts', async () => {
      const total = hiddenCount();
      if (!total) return;
      if (!unsafeWindow.confirm(`Unhide all ${total} posts on every device? This also clears them from the sync server.`)) return;
      for (const id of Object.keys(ledger.hidden)) recordUnhidden(id);
      saveLedgerNow();
      refreshVisuals();
      if (syncEnabled()) {
        const resp = await gmFetch(`${syncBase()}/api/hidden`, 'DELETE', syncHeaders(), JSON.stringify({ all: true }));
        if (resp.ok) {
          ledger.tombs = {};
          saveLedgerNow();
        }
      }
      updateCount();
      pageLog(`[AutoHide] Cleared ${total} hidden posts`);
    });
  }

  // ============================================================
  // Init
  // ============================================================

  function isFeedPage() {
    const path = location.pathname;
    if (path.includes('/comments/') && !path.match(/\/user\/[^/]+\/comments\/?$/)) return false;
    return path === '/' ||
      path.startsWith('/r/') ||
      path.startsWith('/user/') ||
      path === '/popular' ||
      path === '/all' ||
      path.startsWith('/best') ||
      path.startsWith('/hot') ||
      path.startsWith('/new') ||
      path.startsWith('/top') ||
      path.startsWith('/rising');
  }

  function init() {
    ledger = loadLedger();
    registerMenu();
    consumeSyncLink();

    // The sync loop runs on every Reddit page, not just feeds: a queue left over
    // from a fast scroll gets flushed even if the next page is a comment thread.
    startSyncLoop();
    setTimeout(probeForAuth, 1000);
    setTimeout(probeForAuth, 5000);
    pullRemote(true);

    const flush = () => saveLedgerNow();
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveLedgerNow();
      else pullRemote(false);
    });

    feedMode = isFeedPage();
    pageLog(`[AutoHide] v3.2 init on ${location.href} — feed=${feedMode}, ledger=${hiddenCount()}, ` +
      `queued(remote)=${idsNeeding('remote').length}, queued(reddit)=${idsNeeding('reddit').length}, enabled=${enabled}`);
    if (!feedMode) return;

    createToggleUI();
    applyLedgerToPosts();
    setupObserver();
    setupScrollFallback();
    setupMutationObserver();

    let lastUrl = location.href;
    const navObserver = new MutationObserver(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      feedMode = isFeedPage();
      if (!feedMode) return;
      onPage.clear();
      applyLedgerToPosts();
      setupObserver();
      setupMutationObserver();
    });
    navObserver.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }
})();
