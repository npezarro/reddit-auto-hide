import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { HiddenStore, isValidId } from '../lib/store.js';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'hide-store-'));
  const store = new HiddenStore(dir);
  await store.init();
  return { store, dir };
}

test('isValidId accepts reddit link fullnames and rejects everything else', () => {
  assert.ok(isValidId('t3_1abc23'));
  assert.ok(isValidId('t3_ab'));
  assert.ok(!isValidId('t1_1abc23'), 'comment fullname must be rejected');
  assert.ok(!isValidId('1abc23'), 'bare id must be rejected');
  assert.ok(!isValidId('t3_ABC'), 'uppercase must be rejected');
  assert.ok(!isValidId('t3_'), 'empty id must be rejected');
  assert.ok(!isValidId(null));
  assert.ok(!isValidId({ id: 't3_abc' }));
});

test('add is monotonic: re-adding an existing id does not bump its timestamp', async () => {
  const { store, dir } = await freshStore();
  try {
    await store.add(['t3_aaa'], 1000);
    const first = store.delta(0, 100);
    assert.equal(first.hidden.length, 1);
    assert.equal(first.hidden[0].t, 1000);

    const again = await store.add(['t3_aaa'], 5000);
    assert.equal(again.added, 0, 'duplicate add must not count as new');
    const second = store.delta(2000, 100);
    assert.equal(second.hidden.length, 0, 're-add must not resurface the id in a later delta');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('delta returns only changes after the cursor, and separates tombstones', async () => {
  const { store, dir } = await freshStore();
  try {
    await store.add(['t3_aaa', 't3_bbb'], 1000);
    await store.add(['t3_ccc'], 2000);
    await store.remove(['t3_aaa'], 3000);

    const all = store.delta(0, 100);
    assert.deepEqual(all.hidden.map(h => h.id).sort(), ['t3_bbb', 't3_ccc']);
    assert.deepEqual(all.deleted, ['t3_aaa']);
    assert.equal(all.nextSince, 3000);

    const recent = store.delta(1500, 100);
    assert.deepEqual(recent.hidden.map(h => h.id), ['t3_ccc']);
    assert.deepEqual(recent.deleted, ['t3_aaa']);

    const nothing = store.delta(3000, 100);
    assert.equal(nothing.hidden.length, 0);
    assert.equal(nothing.deleted.length, 0);
    assert.equal(nothing.nextSince, 3000, 'cursor must not move when nothing changed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a truncated delta advances the cursor only past rows it actually returned', async () => {
  const { store, dir } = await freshStore();
  try {
    await store.add(['t3_aaa'], 1000);
    await store.add(['t3_bbb'], 2000);
    await store.add(['t3_ccc'], 3000);

    const page = store.delta(0, 2);
    assert.ok(page.truncated);
    assert.equal(page.hidden.length, 2);
    assert.deepEqual(page.hidden.map(h => h.id), ['t3_aaa', 't3_bbb'], 'oldest first');
    assert.equal(page.nextSince, 2000);

    const rest = store.delta(page.nextSince, 2);
    assert.deepEqual(rest.hidden.map(h => h.id), ['t3_ccc']);
    assert.ok(!rest.truncated);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('re-hiding a tombstoned id revives it and propagates as hidden', async () => {
  const { store, dir } = await freshStore();
  try {
    await store.add(['t3_aaa'], 1000);
    await store.remove(['t3_aaa'], 2000);
    const result = await store.add(['t3_aaa'], 3000);
    assert.equal(result.revived, 1);

    const delta = store.delta(2500, 100);
    assert.deepEqual(delta.hidden.map(h => h.id), ['t3_aaa']);
    assert.equal(delta.deleted.length, 0);
    assert.equal(store.liveCount(), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('removeAll tombstones every live id but leaves existing tombstones alone', async () => {
  const { store, dir } = await freshStore();
  try {
    await store.add(['t3_aaa', 't3_bbb'], 1000);
    await store.remove(['t3_aaa'], 2000);
    const result = await store.removeAll(3000);
    assert.equal(result.removed, 1, 'only t3_bbb was still live');
    assert.equal(store.liveCount(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('state survives a restart', async () => {
  const { store, dir } = await freshStore();
  try {
    await store.add(['t3_aaa', 't3_bbb'], 1000);
    await store.remove(['t3_bbb'], 2000);
    await store.persist();

    const reopened = new HiddenStore(dir);
    await reopened.init();
    assert.equal(reopened.liveCount(), 1);
    const delta = reopened.delta(0, 100);
    assert.deepEqual(delta.hidden.map(h => h.id), ['t3_aaa']);
    assert.deepEqual(delta.deleted, ['t3_bbb']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt store file is quarantined instead of crashing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hide-store-'));
  try {
    await writeFile(join(dir, 'hidden.json'), '{not valid json');
    const store = new HiddenStore(dir);
    await store.init();
    assert.equal(store.liveCount(), 0);
    await store.add(['t3_aaa'], 1000);
    assert.equal(store.liveCount(), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tombstones older than the TTL are pruned on write', async () => {
  const { store, dir } = await freshStore();
  try {
    const now = Date.now();
    const ancient = now - 200 * 24 * 60 * 60 * 1000;
    await store.add(['t3_old'], ancient);
    await store.remove(['t3_old'], ancient);
    await store.add(['t3_new'], now);

    assert.ok(!store.entries.has('t3_old'), 'ancient tombstone should be pruned');
    assert.ok(store.entries.has('t3_new'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent adds all land in the persisted file', async () => {
  const { store, dir } = await freshStore();
  try {
    await Promise.all([
      store.add(['t3_a1'], 1000),
      store.add(['t3_a2'], 1001),
      store.add(['t3_a3'], 1002),
      store.add(['t3_a4'], 1003),
    ]);
    await store.writeChain;
    const onDisk = JSON.parse(await readFile(join(dir, 'hidden.json'), 'utf-8'));
    assert.equal(onDisk.entries.length, 4, 'no write should be lost to an interleaved rename');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
