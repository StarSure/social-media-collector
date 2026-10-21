import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAccount, accountSummary, publicationTime, classifyFailure } from '../scripts/collection-quality.mjs';

const spec = { platform: 'tiktok', selection: 'latest', limitPerId: 20, urls: ['https://www.tiktok.com/@sample'] };
const source = { url: spec.urls[0], status: 'completed', termination: 'requested-limit', latestVerified: true };
const videos = () => Array.from({ length: 20 }, (_, index) => ({ platform: 'tiktok', type: 'video', id: String(index + 1), username: 'sample', url: `${spec.urls[0]}/video/${index + 1}`, publishedAt: String(1700000000 + index), playCount: index, likeCount: 0 }));

test('latest requires observed coverage, dates, owner, unique quantity and metrics together', () => {
  const good = assessAccount(spec, source, videos());
  assert.equal(good.source.quality.meetsRequirements, true);
  assert.equal(good.records[0].id, '20');
  assert.equal(good.records.at(-1).id, '1');
  for (const [input, state] of [[videos().slice(1), source], [videos(), { ...source, latestVerified: false }], [videos().map((video, index) => index ? video : { ...video, likeCount: null }), source], [videos().map((video, index) => index ? video : { ...video, publishedAt: null }), source]]) {
    const result = assessAccount(spec, state, input);
    assert.equal(result.source.status, 'partial');
    assert.equal(result.source.quality.meetsRequirements, false);
  }
});

test('duplicate, wrong-author, unsafe-ID and offsite rows cannot fill quota', () => {
  const input = videos();
  const result = assessAccount(spec, source, [input[0], ...input.slice(0, 18), { ...input[19], username: 'other' }, { ...input[19], id: 9007199254740992 }, { ...input[19], url: 'https://attacker.example/video/20' }]);
  assert.equal(result.records.length, 18);
  assert.equal(result.source.quality.duplicateCount, 1);
  assert.equal(result.source.quality.rejectedCount, 3);
  assert.equal(result.source.latestVerified, false);
});

test('embed selections never become latest coverage, while old small jobs still complete', () => {
  const result = assessAccount({ ...spec, selection: 'embed', limitPerId: 3 }, source, videos().slice(0, 3));
  assert.equal(result.source.status, 'completed');
  assert.equal(result.source.latestVerified, false);
});

test('Instagram views satisfy view coverage without inventing play counts', () => {
  const igSpec = { platform: 'instagram', selection: 'latest', limitPerId: 1, urls: ['https://www.instagram.com/sample/'] };
  const result = assessAccount(igSpec, { ...source, url: igSpec.urls[0] }, [{ platform: 'instagram', type: 'video', id: 'AbC', username: 'sample', url: 'https://www.instagram.com/p/AbC/', publishedAt: '2026-10-20T00:00:00Z', viewCount: '99999999999999999999', playCount: null, likeCount: 0 }]);
  assert.equal(result.source.quality.meetsRequirements, true);
  assert.equal(result.records[0].playCount, null);
});

test('unvisited accounts stay visible in the account report after a gate', () => {
  const next = 'https://www.tiktok.com/@next';
  const summary = accountSummary({ ...spec, urls: [...spec.urls, next], sourceRefs: { [next]: ['Sheet1!E3'] } }, [assessAccount(spec, { ...source, status: 'blocked', termination: 'BLOCKED_HTTP_429' }, []).source]);
  assert.equal(summary[0].errorCategory, 'rate-limited');
  assert.equal(summary[1].status, 'skipped');
  assert.equal(summary[1].shortfall, 20);
  assert.deepEqual(summary[1].sourceRefs, ['Sheet1!E3']);
  assert.equal(classifyFailure({ status: 'blocked', termination: 'NAVIGATION_TIMEOUT' }), 'network-timeout');
  assert.equal(classifyFailure({ status: 'blocked', termination: 'LOGIN_REQUIRED' }), 'login-required');
});

test('publication timestamps reject unsafe numbers, arbitrary strings and invalid dates', () => {
  for (const value of [null, '', 'yesterday', '2026-99-99T00:00:00Z', Number.MAX_SAFE_INTEGER, -1, '99999999999999999999']) assert.equal(publicationTime(value), null);
  assert.equal(publicationTime('1700000000'), 1700000000000);
  assert.equal(publicationTime(1700000000), 1700000000000);
});

test('unknown dates beyond the requested slice invalidate latest coverage', () => {
  const result = assessAccount({ ...spec, limitPerId: 1 }, source, [videos()[0], { ...videos()[1], publishedAt: null }]);
  assert.equal(result.source.latestVerified, false);
  assert.equal(result.source.status, 'partial');
  assert.equal(result.source.quality.undatedCandidateCount, 1);
});

test('hidden checkpoint zeros remain unknown and blocked sources never meet acceptance', () => {
  const rows = videos(); rows[0] = { ...rows[0], playCount: 0, likeCount: 0, fieldSources: { playCount: 'profile:hidden', likeCount: 'profile:hidden' } };
  const result = assessAccount(spec, source, rows);
  assert.equal(result.records.find(row => row.id === rows[0].id).likeCount, null);
  assert.equal(result.source.quality.metricCompleteCount, 19);
  assert.equal(assessAccount(spec, { ...source, status: 'partial', termination: 'BLOCKED_HTTP_429' }, videos()).source.quality.meetsRequirements, false);
});
