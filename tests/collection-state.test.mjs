import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCheckpoint, loadCheckpoint, saveCheckpoint, readPreviousSnapshot, metricChanges, writeAnonymousCollection } from '../scripts/collection-state.mjs';

const spec = { platform: 'tiktok', task: 'video', source: 'author-links', selection: 'latest', urls: ['https://www.tiktok.com/@sample'], limitPerId: 20 };
const record = overrides => ({ platform: 'tiktok', type: 'video', id: '9999999999999999999', username: 'sample', url: spec.urls[0] + '/video/9999999999999999999', collectedAt: '2026-10-21T01:00:00Z', playCount: 100, likeCount: 10, ...overrides });
const temp = async callback => { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'collector-state-')); try { return await callback(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); } };

test('atomic checkpoint preserves partial rows and rejects changed job scope', () => temp(async directory => {
  const file = path.join(directory, 'checkpoint.json');
  const checkpoint = createCheckpoint(spec);
  checkpoint.accounts[spec.urls[0]] = { source: { url: spec.urls[0], status: 'partial', loginUsed: false }, records: [record()] };
  await saveCheckpoint(file, checkpoint);
  assert.equal((await loadCheckpoint(file, spec)).accounts[spec.urls[0]].records[0].id, record().id);
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp')), false);
  for (const change of [{ limitPerId: 21 }, { selection: 'embed' }, { platform: 'instagram' }, { urls: ['https://www.tiktok.com/@other'] }]) await assert.rejects(loadCheckpoint(file, { ...spec, ...change }), { code: 'CHECKPOINT_SCOPE_MISMATCH' });
}));

test('checkpoint rejects a foreign account and does not write through file symlinks', () => temp(async directory => {
  const checkpoint = createCheckpoint(spec);
  checkpoint.accounts['https://www.tiktok.com/@other'] = { source: { url: 'https://www.tiktok.com/@other', loginUsed: false }, records: [] };
  const file = path.join(directory, 'checkpoint.json');
  await fs.writeFile(file, JSON.stringify(checkpoint));
  await assert.rejects(loadCheckpoint(file, spec), { code: 'INVALID_CHECKPOINT' });
  const target = path.join(directory, 'untouched.json'); await fs.writeFile(target, 'untouched');
  const link = path.join(directory, 'link.json'); await fs.symlink(target, link);
  await assert.rejects(saveCheckpoint(link, createCheckpoint(spec)), { code: 'INVALID_OUTPUT' });
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
}));

test('new videos, unknown counts and old snapshots never acquire zero baselines', () => {
  const previous = { records: [record({ playCount: null, likeCount: '99999999999999999999' })] };
  const current = { collectedAt: '2026-10-21T02:00:00Z', records: [record({ collectedAt: '2026-10-21T02:00:00Z', likeCount: '100000000000000000005' }), record({ id: '2', collectedAt: '2026-10-21T02:00:00Z', playCount: 0, likeCount: 0 })] };
  const changes = metricChanges(previous, current);
  assert.equal(changes[0].playCountChange, null); assert.equal(changes[0].likeCountChange, 6);
  assert.equal(changes[1].baseline, 'new-video'); assert.equal(changes[1].playCountPrevious, null); assert.equal(changes[1].playCountChange, null);
  const stale = metricChanges(previous, { records: [record()] })[0];
  assert.equal(stale.comparisonStatus, 'snapshot-time-not-newer'); assert.equal(stale.likeCountChange, null);
});

test('counter decreases and unsafe-size differences retain platform values', () => {
  const changes = metricChanges({ records: [record({ playCount: 5, likeCount: 0 })] }, { records: [record({ collectedAt: '2026-10-21T02:00:00Z', playCount: 3, likeCount: '99999999999999999999' })] });
  assert.equal(changes[0].playCountChange, -2);
  assert.equal(changes[0].likeCountChange, '99999999999999999999');
});

test('comparison requires the same platform and source account list before collection', () => temp(async directory => {
  const file = path.join(directory, 'data.json');
  await fs.writeFile(file, JSON.stringify({ platform: 'tiktok', requestedUrls: spec.urls, records: [record()] }));
  assert.equal((await readPreviousSnapshot(file, spec)).records.length, 1);
  await assert.rejects(readPreviousSnapshot(file, { ...spec, platform: 'instagram' }), { code: 'SNAPSHOT_SCOPE_MISMATCH' });
  await assert.rejects(readPreviousSnapshot(file, { ...spec, urls: ['https://www.tiktok.com/@other'] }), { code: 'SNAPSHOT_SCOPE_MISMATCH' });
}));

test('account and change exports retain blanks, long IDs and CSV formula protection', () => temp(async directory => {
  const result = { platform: 'tiktok', collectedAt: '2026-10-21T02:00:00Z', records: [record({ collectedAt: '2026-10-21T02:00:00Z', playCount: null, description: '=FORMULA()' })], accountSummary: [{ url: spec.urls[0], status: 'partial', shortfall: 19, sourceRefs: ['Sheet1!E2'] }] };
  const exported = await writeAnonymousCollection(result, directory, { records: [record()] });
  const csv = await fs.readFile(exported.files.csvFile, 'utf8');
  assert.ok(csv.includes("'=FORMULA()")); assert.ok(csv.includes(record().id));
  const changes = JSON.parse(await fs.readFile(exported.files.changesJsonFile, 'utf8'));
  assert.equal(changes[0].playCount, null); assert.equal(changes[0].playCountChange, null);
  const report = JSON.parse(await fs.readFile(exported.files.reportFile, 'utf8'));
  assert.equal(report.files.accountsFile, exported.files.accountsFile);
  assert.ok((await fs.readFile(exported.files.accountsFile, 'utf8')).includes('Sheet1!E2'));
}));

test('a declared originalUrl cannot smuggle a different resolved account into resume', () => temp(async directory => {
  const checkpoint = createCheckpoint(spec);
  checkpoint.accounts[spec.urls[0]] = { records: [], source: { originalUrl: spec.urls[0], url: 'https://www.tiktok.com/@intruder', status: 'completed', loginUsed: false } };
  const filename = path.join(directory, 'checkpoint.json'); await saveCheckpoint(filename, checkpoint);
  await assert.rejects(loadCheckpoint(filename, spec), { code: 'CHECKPOINT_SCOPE_MISMATCH' });
}));

test('foreign snapshot owners are rejected and hidden historical counters are not baselines', () => temp(async directory => {
  const filename = path.join(directory, 'data.json');
  await fs.writeFile(filename, JSON.stringify({ platform: 'tiktok', requestedUrls: spec.urls, records: [record({ username: 'intruder' })] }));
  await assert.rejects(readPreviousSnapshot(filename, spec), { code: 'SNAPSHOT_SCOPE_MISMATCH' });
  const previous = { records: [record({ likeCount: 0, fieldSources: { likeCount: 'profile:hidden' } })] };
  const changes = metricChanges(previous, { records: [record({ collectedAt: '2026-10-21T02:00:00Z', likeCount: 25 })] });
  assert.equal(changes[0].likeCountPrevious, null);
  assert.equal(changes[0].likeCountChange, null);
}));
