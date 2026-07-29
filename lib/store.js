import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// Reddit fullnames for links: t3_ + base36 id
const ID_RE = /^t3_[a-z0-9]{2,16}$/;

// Tombstones older than this are dropped (an unhide has long since propagated)
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// Hard cap so a runaway client can't grow the file without bound
const MAX_ENTRIES = 100000;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export class HiddenStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.path = join(dataDir, 'hidden.json');
    this.entries = new Map(); // id -> { t: epochMs, deleted: 0|1 }
    this.writeChain = Promise.resolve();
  }

  async init() {
    if (!existsSync(this.dataDir)) await mkdir(this.dataDir, { recursive: true });
    if (!existsSync(this.path)) {
      await this.persist();
      return;
    }
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf-8'));
      for (const e of raw.entries || []) {
        if (isValidId(e.id)) {
          this.entries.set(e.id, { t: Number(e.t) || 0, deleted: e.deleted ? 1 : 0 });
        }
      }
    } catch (err) {
      // Never crash-loop on a corrupt file: quarantine it and start clean.
      const backup = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, backup).catch(() => {});
      console.error(`[store] hidden.json unreadable (${err.message}); quarantined at ${backup}`);
    }
  }

  // Serialize writes: concurrent requests must not interleave temp-file renames.
  persist() {
    this.writeChain = this.writeChain.then(async () => {
      const tmp = `${this.path}.tmp`;
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: Array.from(this.entries, ([id, e]) => ({ id, t: e.t, deleted: e.deleted })),
      };
      await writeFile(tmp, JSON.stringify(payload));
      await rename(tmp, this.path);
    }).catch((err) => {
      console.error(`[store] persist failed: ${err.message}`);
    });
    return this.writeChain;
  }

  /**
   * Add ids as hidden. Monotonic: an add always wins over an older tombstone,
   * and re-adding an already-hidden id does NOT bump its timestamp (otherwise
   * every device's push would resurface every id in every other device's delta).
   */
  async add(ids, now) {
    let added = 0;
    let revived = 0;
    for (const id of ids) {
      const existing = this.entries.get(id);
      if (!existing) {
        this.entries.set(id, { t: now, deleted: 0 });
        added++;
      } else if (existing.deleted) {
        this.entries.set(id, { t: now, deleted: 0 });
        revived++;
      }
    }
    if (added || revived) {
      this.prune(now);
      await this.persist();
    }
    return { added, revived, total: this.liveCount() };
  }

  /** Tombstone ids so unhides propagate to other devices instead of being re-hidden. */
  async remove(ids, now) {
    let removed = 0;
    for (const id of ids) {
      const existing = this.entries.get(id);
      if (existing && !existing.deleted) {
        this.entries.set(id, { t: now, deleted: 1 });
        removed++;
      }
    }
    if (removed) await this.persist();
    return { removed, total: this.liveCount() };
  }

  async removeAll(now) {
    const ids = [];
    for (const [id, e] of this.entries) if (!e.deleted) ids.push(id);
    return this.remove(ids, now);
  }

  /** Everything changed strictly after `since`, so clients can pull deltas. */
  delta(since, limit) {
    const hidden = [];
    const deleted = [];
    let maxT = since;
    let truncated = false;
    // Oldest-first so a truncated page still advances the cursor safely.
    const changed = [];
    for (const [id, e] of this.entries) {
      if (e.t > since) changed.push([id, e]);
    }
    changed.sort((a, b) => a[1].t - b[1].t);
    for (const [id, e] of changed) {
      if (hidden.length + deleted.length >= limit) {
        truncated = true;
        break;
      }
      if (e.deleted) deleted.push(id);
      else hidden.push({ id, t: e.t });
      if (e.t > maxT) maxT = e.t;
    }
    return { hidden, deleted, truncated, nextSince: maxT };
  }

  liveCount() {
    let n = 0;
    for (const e of this.entries.values()) if (!e.deleted) n++;
    return n;
  }

  stats() {
    let live = 0;
    let tombstones = 0;
    let oldest = null;
    let newest = null;
    for (const e of this.entries.values()) {
      if (e.deleted) tombstones++;
      else live++;
      if (oldest === null || e.t < oldest) oldest = e.t;
      if (newest === null || e.t > newest) newest = e.t;
    }
    return { live, tombstones, total: this.entries.size, oldest, newest };
  }

  prune(now) {
    const cutoff = now - TOMBSTONE_TTL_MS;
    for (const [id, e] of this.entries) {
      if (e.deleted && e.t < cutoff) this.entries.delete(id);
    }
    if (this.entries.size <= MAX_ENTRIES) return;
    // Drop the oldest entries first.
    const sorted = Array.from(this.entries).sort((a, b) => a[1].t - b[1].t);
    const excess = this.entries.size - MAX_ENTRIES;
    for (let i = 0; i < excess; i++) this.entries.delete(sorted[i][0]);
    console.warn(`[store] pruned ${excess} oldest entries to stay under ${MAX_ENTRIES}`);
  }
}
