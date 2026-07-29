/**
 * End-to-end test of the real userscript against a real sync server.
 *
 * This exists because the bug it guards against is invisible to unit tests: v2.4
 * hid posts correctly inside a tab session and lost them on the next load. The
 * only way to catch that class of regression is to actually load the page again
 * and look at what is still hidden.
 *
 * The userscript is loaded verbatim. GM_* is shimmed over a JSON file so storage
 * survives page loads (as Tampermonkey's does) and so a second "device" can start
 * from empty storage. GM_xmlhttpRequest is shimmed onto Node's fetch, mirroring
 * Tampermonkey's CORS bypass.
 *
 *   SYNC_BASE=https://host/reddit-hide SYNC_KEY=... node test/integration.mjs
 *
 * Reddit itself is not involved: it bot-walls headless browsers, and the DOM
 * contract under test (shreddit-post elements carrying t3_ ids) is unchanged from
 * the version that already worked in-session.
 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNC_BASE = process.env.SYNC_BASE;
const SYNC_KEY = process.env.SYNC_KEY;
const POST_COUNT = 20;

if (!SYNC_BASE || !SYNC_KEY) {
  console.error('SYNC_BASE and SYNC_KEY must be set');
  process.exit(2);
}

const USERSCRIPT = readFileSync(join(__dirname, '..', 'reddit-auto-hide.user.js'), 'utf-8');
const stamp = Date.now().toString(36).slice(-5);
const ids = Array.from({ length: POST_COUNT }, (_, i) => `t3_zz${stamp}${i.toString(36)}`);
const LAST_ID = ids[ids.length - 1];

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

function fixtureHtml() {
  const posts = ids.map((id, i) => `
    <shreddit-post id="${id}" permalink="/r/test/comments/${id.slice(3)}/post_${i}/">
      <h3>Test post ${i}</h3>
      <a href="/r/test/comments/${id.slice(3)}/post_${i}/">comments</a>
      <div class="filler">${'body text '.repeat(30)}</div>
    </shreddit-post>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fixture Feed</title>
    <style>
      shreddit-post { display:block; min-height: 700px; border-bottom: 1px solid #ccc; }
      body { margin: 0; font-family: sans-serif; }
    </style></head>
    <body><main><shreddit-feed>${posts}</shreddit-feed></main></body></html>`;
}

const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fixtureHtml());
});
await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
const FIXTURE_URL = `http://127.0.0.1:${httpServer.address().port}/`;

/**
 * GM_getValue must be synchronous (the userscript calls it at module scope), and
 * Playwright's exposeFunction is always async. So the store is inlined into the
 * init script at page-open time and written back through an async binding.
 */
function gmShimSource(initialStoreJson) {
  return `
    (() => {
      const __store = ${initialStoreJson};
      window.GM_getValue = (k, d) => (Object.prototype.hasOwnProperty.call(__store, k) ? __store[k] : d);
      window.GM_setValue = (k, v) => { __store[k] = v; __gmWrite(JSON.stringify(__store)); };
      window.GM_addStyle = (css) => {
        const s = document.createElement('style');
        s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
      };
      window.GM_registerMenuCommand = (name, fn) => {
        window.__menu = window.__menu || {};
        window.__menu[name] = fn;
      };
      window.GM_setClipboard = () => {};
      window.unsafeWindow = window;
      window.GM_xmlhttpRequest = (opts) => {
        __gmFetch({ url: opts.url, method: opts.method || 'GET', headers: opts.headers || {}, data: opts.data })
          .then((r) => { if (opts.onload) opts.onload({ status: r.status, responseText: r.body }); })
          .catch((e) => { if (opts.onerror) opts.onerror({ error: String((e && e.message) || e) }); });
      };
    })();
  `;
}

/** A fresh page whose storage comes from `storePath`: i.e. a page load, not a new device. */
async function openPage(browser, storePath, label) {
  if (!existsSync(storePath)) writeFileSync(storePath, '{}');
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await context.newPage();

  await page.exposeFunction('__gmWrite', (s) => { writeFileSync(storePath, s); });
  await page.exposeFunction('__gmFetch', async ({ url, method, headers, data }) => {
    const resp = await fetch(url, { method, headers, body: data });
    return { status: resp.status, body: await resp.text() };
  });

  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[AutoHide]')) console.log(`    [${label}] ${t}`);
  });
  page.on('pageerror', (e) => console.log(`    [${label}] PAGE ERROR: ${e.message}`));

  // Only the GM shim goes in at document-start; the userscript declares
  // @run-at document-idle, so injecting it earlier would break GM_addStyle and
  // test a timing the real thing never sees.
  await page.addInitScript({ content: gmShimSource(readFileSync(storePath, 'utf-8')) });
  await page.goto(FIXTURE_URL, { waitUntil: 'load' });
  await page.evaluate(USERSCRIPT);
  return { context, page };
}

function seedStore(storePath, base, key) {
  writeFileSync(storePath, JSON.stringify({ syncBase: base, syncKey: key }));
}

function ledgerIdsFrom(storePath) {
  const store = JSON.parse(readFileSync(storePath, 'utf-8'));
  if (!store.ledgerV3) return [];
  return Object.keys(JSON.parse(store.ledgerV3).hidden || {});
}

async function scrollThroughFeed(page) {
  await page.evaluate(async () => {
    const step = 600;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 110));
    }
  });
  await page.waitForTimeout(2500); // scroll-past delay plus a sync tick
}

async function serverIds() {
  const r = await fetch(`${SYNC_BASE}/api/hidden?since=0&limit=5000`, {
    headers: { Authorization: `Bearer ${SYNC_KEY}` },
  });
  const d = await r.json();
  return new Set((d.hidden || []).map((h) => h.id));
}

const storeA = join(tmpdir(), `ah-device-a-${stamp}.json`);
const storeB = join(tmpdir(), `ah-device-b-${stamp}.json`);
const browser = await chromium.launch();
let a = null;
let b = null;

try {
  console.log(`\nFixture: ${FIXTURE_URL} (${POST_COUNT} posts)`);
  console.log(`Sync:    ${SYNC_BASE}\n`);

  // ---------------------------------------------------------------
  console.log('1. Device A hides posts by scrolling past them');
  seedStore(storeA, SYNC_BASE, SYNC_KEY);
  a = await openPage(browser, storeA, 'A');
  await a.page.waitForTimeout(1200);

  check('userscript injected its UI', (await a.page.locator('#auto-hide-toggle').count()) === 1);

  await scrollThroughFeed(a.page);
  const fadedInSession = await a.page.locator('shreddit-post.ah-faded').count();
  check(`posts faded during the session (${fadedInSession})`, fadedInSession > 0);

  const hiddenIds = ledgerIdsFrom(storeA);
  check(`ledger persisted to storage (${hiddenIds.length} ids)`, hiddenIds.length > 0);
  check('the last post was never scrolled past, so it is not hidden',
    hiddenIds.length > 0 && !hiddenIds.includes(LAST_ID),
    `LAST_ID ${LAST_ID} unexpectedly in ledger`);

  // ---------------------------------------------------------------
  console.log('\n2. Hides reached the sync server');
  await a.page.waitForTimeout(3000);
  let onServer = await serverIds();
  const missing = hiddenIds.filter((id) => !onServer.has(id));
  check(`server has all ${hiddenIds.length} hidden ids`,
    hiddenIds.length > 0 && missing.length === 0,
    `missing ${missing.length}: ${missing.slice(0, 3).join(', ')}`);

  // ---------------------------------------------------------------
  console.log('\n3. THE REGRESSION: load the page again -- still hidden?');
  await a.context.close();
  a = await openPage(browser, storeA, 'A');
  await a.page.waitForTimeout(2500);

  const collapsedIds = await a.page.$$eval('shreddit-post.ah-collapsed', (els) => els.map((e) => e.id));
  const notCollapsed = hiddenIds.filter((id) => !collapsedIds.includes(id));
  check(`all ${hiddenIds.length} previously hidden posts are collapsed on the new load`,
    hiddenIds.length > 0 && notCollapsed.length === 0,
    `still visible: ${notCollapsed.slice(0, 3).join(', ')}`);
  check('the never-seen last post is still visible',
    !collapsedIds.includes(LAST_ID),
    `${LAST_ID} was collapsed but was never scrolled past`);

  // ---------------------------------------------------------------
  console.log('\n4. Device B (empty storage) picks them up from the server alone');
  seedStore(storeB, SYNC_BASE, SYNC_KEY);
  b = await openPage(browser, storeB, 'B');
  await b.page.waitForTimeout(4000);
  const collapsedOnB = await b.page.$$eval('shreddit-post.ah-collapsed', (els) => els.map((e) => e.id));
  const missingOnB = hiddenIds.filter((id) => !collapsedOnB.includes(id));
  check(`device B collapsed all ${hiddenIds.length} posts from a server pull alone`,
    hiddenIds.length > 0 && missingOnB.length === 0,
    `not collapsed on B: ${missingOnB.slice(0, 3).join(', ')}`);

  // ---------------------------------------------------------------
  console.log('\n5. Unhiding on B propagates to A instead of bouncing back');
  await b.page.evaluate(() => {
    const btn = document.querySelector('#auto-hide-show-btn');
    if (btn) btn.click();
  });
  await b.page.waitForTimeout(400);
  const unhideExists = (await b.page.locator('#auto-hide-unhide-btn').count()) === 1;
  check('unhide control is present on B', unhideExists);
  if (unhideExists) {
    await b.page.evaluate(() => document.querySelector('#auto-hide-unhide-btn').click());
    await b.page.waitForTimeout(4500);
  }

  onServer = await serverIds();
  const stillOnServer = hiddenIds.filter((id) => onServer.has(id));
  check('server no longer lists any of them',
    stillOnServer.length === 0,
    `${stillOnServer.length} still present: ${stillOnServer.slice(0, 3).join(', ')}`);

  await a.context.close();
  a = await openPage(browser, storeA, 'A');
  await a.page.waitForTimeout(4500);
  const collapsedOnAAfter = await a.page.$$eval('shreddit-post.ah-collapsed', (els) => els.map((e) => e.id));
  check(`device A revealed them after pulling the unhide (${collapsedOnAAfter.length} still collapsed)`,
    collapsedOnAAfter.length === 0,
    `still collapsed: ${collapsedOnAAfter.slice(0, 3).join(', ')}`);

  onServer = await serverIds();
  const resurrected = hiddenIds.filter((id) => onServer.has(id));
  check('A did not re-push the unhidden ids',
    resurrected.length === 0,
    `resurrected: ${resurrected.slice(0, 3).join(', ')}`);
} finally {
  if (a) await a.context.close().catch(() => {});
  if (b) await b.context.close().catch(() => {});
  await browser.close();
  httpServer.close();
  await fetch(`${SYNC_BASE}/api/hidden`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${SYNC_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).catch(() => {});
  for (const p of [storeA, storeB]) rmSync(p, { force: true });
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
