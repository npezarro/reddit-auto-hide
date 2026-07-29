import express from 'express';
import cors from 'cors';
import { timingSafeEqual } from 'crypto';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { HiddenStore, isValidId } from './lib/store.js';

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3205;
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');
const API_KEY = process.env.API_KEY || '';
const MAX_IDS_PER_REQUEST = 500;
const DEFAULT_PULL_LIMIT = 5000;

if (API_KEY.length < 24) {
  console.error('FATAL: API_KEY must be set to at least 24 characters (see .env.example)');
  process.exit(1);
}

const store = new HiddenStore(process.env.DATA_DIR || join(__dirname, 'data'));
await store.init();

const app = express();
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

// GM_xmlhttpRequest bypasses CORS, but a direct page fetch from Reddit should work too.
app.use(cors({ origin: [/^https:\/\/([a-z0-9-]+\.)?reddit\.com$/], credentials: false }));
app.use(express.json({ limit: '1mb' }));

// Apache proxies the full path (ProxyPass /reddit-hide -> :3205), so strip the prefix.
app.use((req, _res, next) => {
  if (BASE_PATH && req.url.startsWith(BASE_PATH)) {
    req.url = req.url.slice(BASE_PATH.length) || '/';
  }
  next();
});

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function requireKey(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const key = (match ? match[1] : req.get('x-api-key') || '').trim();
  if (!key || !safeEqual(key, API_KEY)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

/** Accept an ids array, reject junk loudly so a client bug surfaces instead of silently no-oping. */
function parseIds(req, res) {
  const raw = req.body && req.body.ids;
  if (!Array.isArray(raw)) {
    res.status(400).json({ error: 'body must be { ids: [...] }' });
    return null;
  }
  if (raw.length > MAX_IDS_PER_REQUEST) {
    res.status(413).json({ error: `at most ${MAX_IDS_PER_REQUEST} ids per request`, limit: MAX_IDS_PER_REQUEST });
    return null;
  }
  const ids = [];
  const rejected = [];
  for (const id of raw) {
    if (isValidId(id)) ids.push(id);
    else rejected.push(String(id).slice(0, 32));
  }
  if (rejected.length) console.warn(`[api] rejected ${rejected.length} malformed ids: ${rejected.slice(0, 5).join(', ')}`);
  return { ids, rejected };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'reddit-hide-sync', count: store.liveCount(), now: Date.now() });
});

// Delta pull. `since=0` (or omitted) returns the full live set.
app.get('/api/hidden', requireKey, (req, res) => {
  const since = Number(req.query.since) || 0;
  const limit = Math.min(Number(req.query.limit) || DEFAULT_PULL_LIMIT, DEFAULT_PULL_LIMIT);
  const { hidden, deleted, truncated, nextSince } = store.delta(since, limit);
  res.json({ now: Date.now(), since, nextSince, truncated, hidden, deleted, total: store.liveCount() });
});

app.post('/api/hidden', requireKey, async (req, res) => {
  const parsed = parseIds(req, res);
  if (!parsed) return;
  const now = Date.now();
  const result = await store.add(parsed.ids, now);
  res.json({ ...result, rejected: parsed.rejected.length, now });
});

app.delete('/api/hidden', requireKey, async (req, res) => {
  const now = Date.now();
  if (req.body && req.body.all === true) {
    const result = await store.removeAll(now);
    return res.json({ ...result, now });
  }
  const parsed = parseIds(req, res);
  if (!parsed) return;
  const result = await store.remove(parsed.ids, now);
  return res.json({ ...result, rejected: parsed.rejected.length, now });
});

app.get('/api/stats', requireKey, (_req, res) => {
  res.json({ ...store.stats(), now: Date.now() });
});

app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`reddit-hide-sync listening on 127.0.0.1:${PORT} (basePath="${BASE_PATH || '/'}", ${store.liveCount()} hidden)`);
});
