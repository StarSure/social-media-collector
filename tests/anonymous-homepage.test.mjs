import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnonymousArguments, validateAnonymousSpec, collectAnonymousHomepages } from '../scripts/anonymous-homepage.mjs';
import { createCheckpoint } from '../scripts/collection-state.mjs';

const input = { platform: 'tiktok', task: 'video', source: 'author-links', urls: ['https://www.tiktok.com/@sample'], limitPerId: 3 };

test('anonymous runner accepts account homepage videos and explicit bounded limits', () => {
  assert.deepEqual(validateAnonymousSpec({ ...input, urls: ['https://tiktok.com/@sample?tracking=x'] }), input);
  for (const limitPerId of [undefined, 0, -1, 11, '3']) assert.throws(() => validateAnonymousSpec({ ...input, limitPerId }));
  for (const urls of [[], ['https://www.tiktok.com/@sample/video/123'], ['https://www.tiktok.com/@sample', 'https://www.tiktok.com/@SAMPLE/']]) assert.throws(() => validateAnonymousSpec({ ...input, urls }));
  assert.equal(validateAnonymousSpec({ ...input, platform: 'instagram', urls: ['https://www.instagram.com/instagram/'] }).platform, 'instagram');
  assert.throws(() => validateAnonymousSpec({ ...input, platform: 'instagram', urls: ['https://www.instagram.com/instagram/'], limitPerId: 7 }));
});

test('anonymous runner cannot attach to saved sessions, receive cookies, or change the source', () => {
  assert.equal(parseAnonymousArguments(['collect', '--spec', 'job.json']).command, 'collect');
  for (const option of ['endpoint', 'profile', 'cookie', 'storageState']) {
    assert.throws(() => parseAnonymousArguments(['collect', '--spec', 'job.json', `--${option}`, 'value']));
    assert.throws(() => validateAnonymousSpec({ ...input, [option]: 'value' }));
  }
  assert.throws(() => validateAnonymousSpec({ ...input, source: 'keyword' }));
  assert.throws(() => parseAnonymousArguments(['collect', '--spec', 'one.json', '--spec', 'two.json']));
});

test('latest20 is explicit and distinct from the limited embed selection', () => {
  const spec = validateAnonymousSpec({ ...input, selection: 'latest', limitPerId: 20, verifyWith: { [input.urls[0]]: 'https://www.tiktok.com/@old_name/video/123?tracking=discard' }, sourceRefs: { [input.urls[0]]: ['Source!E2'] } });
  assert.equal(spec.limitPerId, 20); assert.equal(spec.selection, 'latest');
  assert.equal(spec.verifyWith[input.urls[0]], 'https://www.tiktok.com/@old_name/video/123');
  assert.deepEqual(spec.sourceRefs[input.urls[0]], ['Source!E2']);
  assert.throws(() => validateAnonymousSpec({ ...input, selection: 'latest', limitPerId: 101 }));
  assert.throws(() => validateAnonymousSpec({ ...input, selection: 'latest', verifyWith: { [input.urls[0]]: 'https://attacker.example/@sample/video/123' } }));
  assert.throws(() => validateAnonymousSpec({ ...input, sourceRefs: { 'https://www.tiktok.com/@other': ['E2'] } }));
  assert.equal(parseAnonymousArguments(['collect', '--spec', 'job.json', '--resume', 'checkpoint.json', '--previous', 'data.json']).options.resume, 'checkpoint.json');
});

test('same-task completed sources resume without refetch and retain observation times', async () => {
  const spec = validateAnonymousSpec({ ...input, selection: 'latest', limitPerId: 20 });
  const checkpoint = createCheckpoint(spec);
  const records = Array.from({ length: 20 }, (_, index) => ({ platform: 'tiktok', type: 'video', id: String(index + 1), username: 'sample', url: `${input.urls[0]}/video/${index + 1}`, publishedAt: String(1700000000 + index), playCount: 1, likeCount: 0, collectedAt: '2026-10-20T00:00:00Z' }));
  checkpoint.accounts[input.urls[0]] = { records, source: { url: input.urls[0], status: 'completed', termination: 'requested-limit', latestVerified: true, loginUsed: false } };
  let saved = 0;
  const result = await collectAnonymousHomepages(spec, { newContext: async () => { throw new Error('Completed sources must not refetch during resume'); } }, { checkpoint, onCheckpoint: async () => { saved++; } });
  assert.equal(result.status, 'completed'); assert.equal(result.recordCount, 20); assert.equal(saved, 1);
  assert.equal(result.records[0].collectedAt, '2026-10-20T00:00:00Z');
  assert.equal(result.records[0].restoredFromCheckpoint, true);
  assert.equal(result.acceptance.restoredRecordCount, 20);
  assert.equal(result.sources[0].resumed, true);
});
