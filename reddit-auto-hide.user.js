// ==UserScript==
// @name         Reddit Auto-Hide Seen Posts
// @namespace    https://github.com/npezarro/scripts
// @version      2.0
// @description  Automatically hides Reddit posts after you scroll past them. Toggle to reveal hidden posts. Syncs across devices via Reddit's native hide API.
// @author       npezarro
// @match        *://*.reddit.com/*
// @exclude      *://www.reddit.com/api/*
// @exclude      *://mod.reddit.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      oauth.reddit.com
// @run-at       document-idle
// @updateURL    https://gist.githubusercontent.com/npezarro/a15e7b64beb7c746509be820fa0d07c6/raw/reddit-auto-hide.user.js
// @downloadURL  https://gist.githubusercontent.com/npezarro/a15e7b64beb7c746509be820fa0d07c6/raw/reddit-auto-hide.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --- Config ---
  const SCROLL_PAST_DELAY_MS = 500;
  const HIDE_BATCH_INTERVAL_MS = 2000;

  // --- State ---
  let enabled = GM_getValue('autoHideEnabled', true);
  let showHidden = false;
  const pendingHides = new Set();       // post IDs queued for API hide call
  const seenTimers = new Map();         // postId -> timeout handle
  const seenInViewport = new Set();     // posts that entered viewport at least once
  const fadedPosts = new Map();         // postId -> DOM element (locally faded, source of truth for UI)
  const apiHidden = new Set();          // posts successfully hidden via API
  let batchInterval = null;
  let observer = null;
  let mutationObserver = null;
  let countDisplay = null;

  // --- Logging via page console (visible to browser-logs) ---
  const pageLog = unsafeWindow.console.log.bind(unsafeWindow.console);
  const pageWarn = unsafeWindow.console.warn.bind(unsafeWindow.console);

  // --- Detect Reddit variant ---
  function isOldReddit() {
    return location.hostname === 'old.reddit.com' ||
      document.querySelector('#siteTable') !== null;
  }

  // --- Extract post fullname from DOM element ---
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

  // --- Get all post elements on the page ---
  function getPostElements() {
    if (isOldReddit()) {
      return document.querySelectorAll('#siteTable > .thing.link');
    }
    const shredditPosts = document.querySelectorAll('shreddit-post');
    if (shredditPosts.length > 0) return shredditPosts;
    return document.querySelectorAll('article[data-testid="post-container"]');
  }

  // --- Steal Reddit's auth by intercepting fetch AND XHR ---
  const captureScript = document.createElement('script');
  captureScript.textContent = `(function() {
    window.__redditAuthHeaders = null;

    // Intercept fetch
    var origFetch = window.fetch;
    window.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      try {
        var h = init && init.headers;
        if (h) {
          var captured = {};
          if (h instanceof Headers) {
            h.forEach(function(v, k) { captured[k.toLowerCase()] = v; });
          } else if (typeof h === 'object') {
            for (var k in h) { if (h.hasOwnProperty(k)) captured[k.toLowerCase()] = h[k]; }
          }
          if (captured['authorization']) {
            window.__redditAuthHeaders = captured;
            window.dispatchEvent(new CustomEvent('__redditAuth', { detail: captured }));
          }
        }
      } catch(e) {}
      return origFetch.apply(this, arguments);
    };

    // Intercept XHR
    var origOpen = XMLHttpRequest.prototype.open;
    var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__url = url;
      this.__headers = {};
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
      this.__headers[name.toLowerCase()] = value;
      return origSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
      if (this.__headers && this.__headers['authorization']) {
        window.__redditAuthHeaders = this.__headers;
        window.dispatchEvent(new CustomEvent('__redditAuth', { detail: this.__headers }));
      }
      return origSend.apply(this, arguments);
    };
  })();`;
  (document.head || document.documentElement).prepend(captureScript);
  captureScript.remove();

  // Listen for captured auth
  let capturedHeaders = null;
  window.addEventListener('__redditAuth', (e) => {
    capturedHeaders = e.detail;
    pageLog('[AutoHide] Captured auth: ' + Object.keys(capturedHeaders).join(', '));
  });

  function getCapturedHeaders() {
    if (capturedHeaders) return capturedHeaders;
    try {
      if (unsafeWindow.__redditAuthHeaders) {
        capturedHeaders = unsafeWindow.__redditAuthHeaders;
        return capturedHeaders;
      }
    } catch {}
    return null;
  }

  // --- Reddit API: hide/unhide via GM_xmlhttpRequest (bypasses CORS) ---
  function gmFetch(url, method, headers, body) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: body,
        timeout: 10000,
        onload: (r) => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText }),
        onerror: (e) => resolve({ ok: false, status: 0, text: `Network error: ${e.error || 'unknown'}` }),
        ontimeout: () => resolve({ ok: false, status: 0, text: 'Timeout' }),
      });
    });
  }

  async function hidePost(id) {
    const auth = getCapturedHeaders();

    if (auth && auth['authorization']) {
      const resp = await gmFetch('https://oauth.reddit.com/api/hide', 'POST', {
        'Authorization': auth['authorization'],
        'Content-Type': 'application/x-www-form-urlencoded',
      }, `id=${id}`);

      if (resp.ok) {
        apiHidden.add(id);
        pageLog(`[AutoHide] Hidden via oauth: ${id}`);
        return;
      }
      pageWarn(`[AutoHide] oauth hide ${resp.status}: ${resp.text.slice(0, 200)}`);
    } else {
      pageWarn(`[AutoHide] No auth captured yet for ${id}`);
    }
  }

  async function unhidePost(id) {
    const auth = getCapturedHeaders();
    if (!auth || !auth['authorization']) return;

    const resp = await gmFetch('https://oauth.reddit.com/api/unhide', 'POST', {
      'Authorization': auth['authorization'],
      'Content-Type': 'application/x-www-form-urlencoded',
    }, `id=${id}`);

    if (resp.ok) {
      apiHidden.delete(id);
      pageLog(`[AutoHide] Unhidden: ${id}`);
    } else {
      pageWarn(`[AutoHide] Unhide ${resp.status}: ${id}`);
    }
  }

  // --- Update counter display ---
  function updateCount() {
    if (countDisplay) {
      const pending = pendingHides.size;
      const faded = fadedPosts.size;
      countDisplay.textContent = pending > 0
        ? `${faded} hidden (${pending} queued)`
        : `${faded} hidden`;
    }
  }

  // --- Fade a post element ---
  function fadePost(postId, el) {
    fadedPosts.set(postId, el);
    pendingHides.add(postId);
    el.style.transition = 'opacity 0.3s';
    el.style.opacity = '0.15';
    updateCount();
    pageLog(`[AutoHide] Faded ${postId} (${fadedPosts.size} total)`);
  }

  // --- Batch processor: send hide API calls ---
  function startBatchProcessor() {
    if (batchInterval) return;
    batchInterval = setInterval(async () => {
      if (!enabled || pendingHides.size === 0) return;
      // Process up to 5 per tick to avoid rate limits
      const batch = Array.from(pendingHides).slice(0, 5);
      batch.forEach(id => pendingHides.delete(id));
      for (const id of batch) {
        await hidePost(id);
      }
      updateCount();
    }, HIDE_BATCH_INTERVAL_MS);
  }

  // --- IntersectionObserver: detect scrolled-past posts ---
  function setupObserver() {
    if (observer) observer.disconnect();

    observer = new IntersectionObserver((entries) => {
      if (!enabled || showHidden) return;

      for (const entry of entries) {
        const postId = getPostId(entry.target);
        if (!postId) continue;

        if (entry.isIntersecting) {
          seenInViewport.add(postId);
          if (seenTimers.has(postId)) {
            clearTimeout(seenTimers.get(postId));
            seenTimers.delete(postId);
          }
        } else {
          if (seenInViewport.has(postId) && !fadedPosts.has(postId) && !seenTimers.has(postId)) {
            const rect = entry.target.getBoundingClientRect();
            if (rect.bottom < 0) {
              const el = entry.target;
              seenTimers.set(postId, setTimeout(() => {
                seenTimers.delete(postId);
                fadePost(postId, el);
              }, SCROLL_PAST_DELAY_MS));
            }
          }
        }
      }
    }, {
      threshold: [0, 0.1],
      rootMargin: '0px',
    });

    observeAllPosts();
  }

  function observeAllPosts() {
    if (!observer) return;
    const posts = getPostElements();
    posts.forEach(post => {
      if (!post.dataset.autoHideObserved) {
        observer.observe(post);
        post.dataset.autoHideObserved = 'true';
      }
    });
  }

  // --- Watch for dynamically loaded posts (infinite scroll) ---
  function setupMutationObserver() {
    if (mutationObserver) mutationObserver.disconnect();

    mutationObserver = new MutationObserver(() => {
      observeAllPosts();
    });

    const feedContainer = isOldReddit()
      ? document.querySelector('#siteTable')
      : document.querySelector('shreddit-feed, [data-testid="posts-list"], main');

    if (feedContainer) {
      mutationObserver.observe(feedContainer, { childList: true, subtree: true });
    } else {
      mutationObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  // --- Toggle UI ---
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
    showBtn.title = 'Temporarily reveal posts hidden this session';
    showBtn.addEventListener('click', () => {
      showHidden = !showHidden;
      showBtn.textContent = showHidden ? 'Resume Hiding' : 'Show Hidden';
      showBtn.classList.toggle('active', showHidden);

      if (showHidden) {
        for (const [, el] of fadedPosts) {
          el.style.opacity = '1';
        }
      } else {
        for (const [, el] of fadedPosts) {
          el.style.opacity = '0.15';
        }
      }
    });

    const unhideAllBtn = document.createElement('button');
    unhideAllBtn.id = 'auto-hide-unhide-btn';
    unhideAllBtn.textContent = 'Unhide All';
    unhideAllBtn.title = 'Unhide all posts hidden this session (restores them permanently)';
    unhideAllBtn.addEventListener('click', async () => {
      if (fadedPosts.size === 0) return;
      unhideAllBtn.textContent = 'Unhiding...';

      // Restore opacity immediately
      for (const [, el] of fadedPosts) {
        el.style.opacity = '1';
      }

      // Unhide via API for any that were API-hidden
      const toUnhide = Array.from(apiHidden);
      for (const id of toUnhide) {
        await unhidePost(id);
      }

      fadedPosts.clear();
      pendingHides.clear();
      apiHidden.clear();
      updateCount();

      unhideAllBtn.textContent = 'Unhide All';
      showHidden = false;
      showBtn.textContent = 'Show Hidden';
      showBtn.classList.remove('active');
    });

    countDisplay = document.createElement('span');
    countDisplay.id = 'auto-hide-count';
    countDisplay.textContent = '0 hidden';

    container.appendChild(enableBtn);
    container.appendChild(showBtn);
    container.appendChild(unhideAllBtn);
    container.appendChild(countDisplay);
    document.body.appendChild(container);
  }

  // --- Styles ---
  GM_addStyle(`
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

    #auto-hide-toggle:hover {
      opacity: 1 !important;
    }

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

    #auto-hide-toggle button:hover {
      background: #3a3a3c;
    }

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
      #auto-hide-toggle button:hover {
        background: #e8e8e8;
      }
      #auto-hide-count {
        color: #7c7c7c;
      }
    }

    #auto-hide-toggle:not(:hover) #auto-hide-show-btn,
    #auto-hide-toggle:not(:hover) #auto-hide-unhide-btn {
      display: none;
    }
  `);

  // --- Skip non-feed pages ---
  function isFeedPage() {
    const path = location.pathname;
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

  // --- Init ---
  function init() {
    if (location.pathname.includes('/comments/') && !location.pathname.endsWith('/comments/')) {
      if (!location.pathname.match(/\/user\/[^/]+\/comments\/?$/)) return;
    }
    if (!isFeedPage()) return;

    const posts = getPostElements();
    pageLog(`[AutoHide] v1.4 init on ${location.href} — ${posts.length} posts, enabled=${enabled}`);
    createToggleUI();
    setupObserver();
    setupMutationObserver();
    startBatchProcessor();

    let lastUrl = location.href;
    const navObserver = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        if (isFeedPage()) {
          setupObserver();
          setupMutationObserver();
        }
      }
    });
    navObserver.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }
})();
