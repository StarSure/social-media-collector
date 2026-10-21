import test from 'node:test';
import assert from 'node:assert/strict';
import { collectInstagramLatest, resolveInstagramVideoAuthor, reusableInstagramRecord } from '../scripts/instagram-latest.mjs';
import { extractInstagramVideos, extractInstagramListVideos, instagramTimelineEvidence, extractInstagramVideoAuthor } from '../scripts/instagram-homepage.mjs';

const profileUrl = 'https://www.instagram.com/fixture.creator/';
const video = (code, time = 100) => ({ __typename: 'GraphVideo', shortcode: code, owner: { username: 'fixture.creator' }, taken_at_timestamp: time, video_view_count: 50, edge_liked_by: { count: 4 } });
const json = value => JSON.stringify(value);
const complete = nodes => ({ data: { user: { username: 'fixture.creator', edge_owner_to_timeline_media: { count: nodes.length, edges: nodes.map(node => ({ node })), page_info: { has_next_page: false, end_cursor: null } } } } });

function fakeBrowser({ profile = [], details = {}, redirect = null, status = 200, retryAfter = null, observedText = '', onScroll, onProfile, navigationError, onDetail } = {}) {
  const calls = [], listeners = [], state = { closed: 0, scrolls: 0, pageClosed: false };
  let current = profileUrl;
  const response = (url, body, code = 200, headers = {}) => ({ url: () => url, status: () => code, headers: () => ({ 'content-type': 'text/html', ...headers }), text: async () => `<script type="application/json">${json(body)}</script>`, request: () => ({ resourceType: () => 'document' }), json: async () => body });
  const page = {
    on(event, listener) { if (event === 'response') listeners.push(listener); },
    url: () => current,
    close: async () => { state.pageClosed = true; },
    goto: async url => {
      current = url; calls.push(url);
      if (navigationError) throw navigationError;
      if (url === profileUrl && redirect) {
        const item = response(url, {}, 302, { location: redirect }); listeners.forEach(listener => listener(item));
        if (state.pageClosed) throw Error('page closed after redirect');
        current = redirect;
      }
      const code = url.match(/\/p\/([^/]+)\//)?.[1];
      const body = code ? details[code] ?? video(code) : profile;
      const selectedStatus = code && body?.httpStatus ? body.httpStatus : code ? 200 : status;
      const item = response(url, body, selectedStatus, retryAfter ? { 'retry-after': retryAfter } : {});
      listeners.forEach(listener => listener(item));
      if (code) onDetail?.(code); else onProfile?.(state, listeners);
      return item;
    },
    evaluate: async fn => {
      if (fn.toString().includes('window.scrollBy')) { state.scrolls++; onScroll?.(state, listeners); return; }
      return { text: observedText, challenge: false, login: false, scripts: [json(profile)], links: [] };
    },
    waitForTimeout: async () => {},
  };
  return { calls, state, newContext: async settings => { assert.deepEqual(settings, { javaScriptEnabled: true }); return { route: async () => {}, newPage: async () => page, close: async () => state.closed++ }; } };
}

test('list parser supports 100 while old embed parser still rejects seven, and preserves source Unix seconds', () => {
  const values = Array.from({ length: 22 }, (_, i) => video(`Case${i}`, 100 + i));
  const records = extractInstagramListVideos([json([values[0], ...values, { ...video('IMAGE'), __typename: 'GraphImage' }, { ...video('OTHER'), owner: { username: 'other' } }, { ...video('REC'), is_recommendation: true }])], { expectedUsername: 'fixture.creator', limitPerId: 20 });
  assert.equal(records.length, 20); assert.equal(records[1].publishedAt, 101); assert.match(records[1].fieldSources.publishedAt, /taken_at_timestamp$/);
  assert.throws(() => extractInstagramVideos([], { expectedUsername: 'fixture.creator', limitPerId: 7 }), { code: 'INVALID_LIMIT' });
});

test('timeline proof requires complete owned unique edges, not terminal page alone', () => {
  const nodes = [video('A', 300), video('B', 200)];
  assert.equal(instagramTimelineEvidence([json(complete(nodes))], 'fixture.creator').completeLists.length, 1);
  for (const value of [complete([nodes[0], nodes[0]]), complete([nodes[0], { ...nodes[1], owner: { username: 'someone' } }]), { data: { user: { username: 'fixture.creator', edge_owner_to_timeline_media: { count: 100, edges: nodes.map(node => ({ node })), page_info: { has_next_page: false } } } } }]) assert.equal(instagramTimelineEvidence([json(value)], 'fixture.creator').completeLists.length, 0);
});

test('login redirect stops before scripts, scrolls, or detail requests regardless of localized text', async () => {
  const browser = fakeBrowser({ redirect: 'https://www.instagram.com/accounts/login/?next=fixture' });
  const result = await collectInstagramLatest(browser, { url: profileUrl, limitPerId: 20 });
  assert.equal(result.source.termination, 'LOGIN_REQUIRED'); assert.equal(result.source.diagnostics.httpStatus, 302);
  assert.equal(result.source.diagnostics.stage, 'profile-discovery'); assert.equal(browser.state.scrolls, 0); assert.equal(browser.calls.length, 1); assert.equal(browser.state.closed, 1);
});

test('HTTP diagnostics preserve stage, path and raw Retry-After without retry', async () => {
  const browser = fakeBrowser({ status: 429, retryAfter: 'Wed, 21 Oct 2026 10:00:00 GMT' });
  const result = await collectInstagramLatest(browser, { url: profileUrl, limitPerId: 20 });
  assert.equal(result.source.termination, 'BLOCKED_HTTP_429'); assert.deepEqual(result.source.diagnostics, { stage: 'profile-discovery', path: '/fixture.creator/', httpStatus: 429, retryAfter: 'Wed, 21 Oct 2026 10:00:00 GMT' }); assert.equal(browser.calls.length, 1);
});

test('full owned list sorts by publication time, so an old pinned item cannot precede newer videos', async () => {
  const nodes = [{ ...video('PIN', 100), is_pinned: true }, video('LATEST', 300), video('SECOND', 200)];
  const browser = fakeBrowser({ profile: complete(nodes), details: Object.fromEntries(nodes.map(node => [node.shortcode, node])) });
  const saved = []; const result = await collectInstagramLatest(browser, { url: profileUrl, limitPerId: 2, onProgress: async rows => { await Promise.resolve(); saved.push(rows.map(row => row.id)); } });
  assert.equal(result.source.status, 'completed'); assert.equal(result.source.latestVerified, true); assert.deepEqual(result.records.map(record => record.id), ['LATEST', 'SECOND']); assert.deepEqual(saved, [['LATEST'], ['LATEST', 'SECOND']]); assert.equal(browser.state.scrolls, 0);
});

test('twenty verified media objects do not prove a latest continuous range', async () => {
  const nodes = Array.from({ length: 20 }, (_, index) => video(`Video${index}`, 100 + index));
  const browser = fakeBrowser({ profile: nodes, details: Object.fromEntries(nodes.map(node => [node.shortcode, node])) });
  const result = await collectInstagramLatest(browser, { url: profileUrl, limitPerId: 20 });
  assert.equal(result.records.length, 20); assert.equal(result.source.status, 'partial'); assert.equal(result.source.termination, 'latest-order-unverified'); assert.equal(result.source.latestVerified, false);
});

test('no new public videos stops after three natural scrolls', async () => {
  const browser = fakeBrowser(); const result = await collectInstagramLatest(browser, { url: profileUrl, limitPerId: 20 });
  assert.equal(browser.state.scrolls, 3); assert.equal(result.source.discoveryTermination, 'three-scrolls-without-new-videos'); assert.equal(result.records.length, 0); assert.equal(result.source.latestVerified, false);
});

test('detail barrier preserves previously verified progress and never requests the next video', async () => {
  const nodes = [video('A', 300), video('B', 200), video('C', 100)];
  const browser = fakeBrowser({ profile: complete(nodes), details: { A: nodes[0], B: { httpStatus: 403 }, C: nodes[2] } });
  const progress = []; const result = await collectInstagramLatest(browser, { url: profileUrl, limitPerId: 3, onProgress: async rows => progress.push(rows.length) });
  assert.equal(result.source.status, 'partial'); assert.equal(result.source.termination, 'BLOCKED_HTTP_403'); assert.deepEqual(progress, [1]); assert.equal(result.records.length, 1); assert.equal(browser.calls.some(url => url.includes('/p/C/')), false); assert.equal(result.source.diagnostics.stage, 'video-detail');
});

test('checkpoint reuse requires current discovery, exact owner/time and complete prior metrics', async () => {
  const node = video('A', 300); const record = extractInstagramListVideos([json(node)], { expectedUsername: 'fixture.creator', limitPerId: 1 })[0];
  const old = { ...record, collectedAt: '2026-10-21T00:00:00Z' };
  assert.equal(reusableInstagramRecord(old, record), true); assert.equal(reusableInstagramRecord({ ...old, publishedAt: 200 }, record), false); assert.equal(reusableInstagramRecord({ ...old, username: 'other' }, record), false);
  const browser = fakeBrowser({ profile: complete([node]) });
  const result = await collectInstagramLatest(browser, { url: profileUrl, limitPerId: 1, resumeRecords: [old, { ...old, id: 'STALE', shortcode: 'STALE' }] });
  assert.equal(browser.calls.length, 1); assert.equal(result.records[0].restoredFromCheckpoint, true); assert.equal(result.records[0].collectedAt, old.collectedAt); assert.equal(result.records.length, 1);
});

test('known shortcode author resolution uses actual JSON owner and a fresh context, never the row label', async () => {
  const browser = fakeBrowser({ details: { Known: { ...video('Known'), owner: { username: 'Current.Owner' } } } });
  const result = await resolveInstagramVideoAuthor(browser, 'https://www.instagram.com/reels/Known/?utm_source=fixture');
  assert.equal(result.url, 'https://www.instagram.com/Current.Owner/'); assert.equal(result.videoId, 'Known'); assert.equal(result.httpStatus, 200); assert.equal(browser.calls.length, 1); assert.equal(browser.state.closed, 1);
  assert.throws(() => extractInstagramVideoAuthor([json(video('Other'))], 'Known'), { code: 'AUTHOR_UNCONFIRMED' });
});

test('untrusted script expressions cannot execute while resolving authors or lists', () => {
  globalThis.__igExecuted = false;
  const script = 's.handle((()=>{globalThis.__igExecuted=true;return {}})())';
  assert.deepEqual(extractInstagramListVideos([script], { expectedUsername: 'fixture.creator', limitPerId: 20 }), []);
  assert.throws(() => extractInstagramVideoAuthor([script], 'Known'), { code: 'AUTHOR_UNCONFIRMED' }); assert.equal(globalThis.__igExecuted, false); delete globalThis.__igExecuted;
});

test('an undated video anywhere in the complete timeline prevents latest verification even outside the requested slice', async () => {
  const nodes = [video('DATED', 100), { ...video('UNKNOWN'), taken_at_timestamp: undefined }];
  const browser = fakeBrowser({ profile: complete(nodes), details: { DATED: nodes[0] } });
  const result = await collectInstagramLatest(browser, { url: profileUrl, limitPerId: 1 });
  assert.equal(result.records.length, 1); assert.equal(result.source.latestVerified, false); assert.equal(result.source.termination, 'latest-order-unverified');
});

test('a complete feed beyond the parser bound cannot be promoted to a fully covered timeline', async () => {
  const nodes = Array.from({ length: 101 }, (_, i) => video(`Bound${i}`, 100 + i));
  const browser = fakeBrowser({ profile: complete(nodes), details: Object.fromEntries(nodes.map(node => [node.shortcode, node])) });
  const result = await collectInstagramLatest(browser, { url: profileUrl, limitPerId: 1 });
  assert.equal(result.source.discoveryCount, 100); assert.equal(result.source.latestVerified, false); assert.equal(result.source.status, 'partial');
});

test('private profile and private media ownership stop without reading details', async () => {
  for (const profile of [{ username: 'fixture.creator', is_private: true }, { ...video('Private'), owner: { username: 'fixture.creator', is_private: true } }, { ...video('Private'), is_private: true }]) {
    const browser = fakeBrowser({ profile }); const result = await collectInstagramLatest(browser, { url: profileUrl, limitPerId: 20 });
    assert.equal(result.source.termination, 'PRIVATE_PROFILE'); assert.equal(result.records.length, 0); assert.equal(browser.calls.length, 1); assert.equal(browser.state.scrolls, 0);
  }
});

test('navigation TimeoutError has a diagnostic code and never becomes a generic collection failure', async () => {
  const browser = fakeBrowser({ navigationError: Object.assign(new Error('fixture timeout'), { name: 'TimeoutError' }) });
  const result = await collectInstagramLatest(browser, { url: profileUrl, limitPerId: 20 });
  assert.equal(result.source.termination, 'NAVIGATION_TIMEOUT'); assert.deepEqual(result.source.http, { status: null, stage: 'profile-discovery', path: '/fixture.creator/', retryAfter: null });
});

test('unrelated malformed analytics JSON is ignored, while event diagnostics remain bounded', async () => {
  const analytics = { url: () => 'https://www.instagram.com/ajax/analytics/', status: () => 200, headers: () => ({ 'content-type': 'application/json' }), request: () => ({ resourceType: () => 'xhr' }), json: async () => { throw Error('not JSON'); } };
  const browser = fakeBrowser({ onScroll: (_, listeners) => { for (let i = 0; i < 30; i++) listeners.forEach(listener => listener(analytics)); } });
  const result = await collectInstagramLatest(browser, { url: profileUrl, limitPerId: 20 });
  assert.equal(result.source.termination, 'latest-order-unverified'); assert.ok(result.source.ignoredJsonResponses > 0); assert.ok(result.source.httpEvents.length <= 50); assert.equal(result.source.http, undefined);
});

test('delayed JSON cannot replace the evidence after discovery has frozen its selected snapshot', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const old = video('OLD', 100), newer = video('NEW', 200);
  const response = { url: () => 'https://www.instagram.com/public/timeline/', status: () => 200, headers: () => ({ 'content-type': 'application/json' }), request: () => ({ resourceType: () => 'xhr' }), json: async () => delayed };
  const browser = fakeBrowser({ profile: complete([old]), details: { OLD: old }, onProfile: (_, listeners) => listeners.forEach(listener => listener(response)), onDetail: () => release(complete([newer])) });
  const result = await collectInstagramLatest(browser, { url: profileUrl, limitPerId: 1 });
  assert.deepEqual(result.records.map(record => record.id), ['OLD']); assert.equal(result.source.discoveryCount, 1); assert.equal(result.source.latestVerified, true);
});

test('author resolution failures retain the observed document status and structured HTTP fields', async () => {
  const browser = fakeBrowser({ details: { Known: {} } });
  await assert.rejects(resolveInstagramVideoAuthor(browser, 'https://www.instagram.com/p/Known/'), error => error.code === 'AUTHOR_UNCONFIRMED' && error.http.status === 200 && error.http.stage === 'author-resolution' && error.http.path === '/p/Known/embed/');
  await assert.rejects(resolveInstagramVideoAuthor(browser, 'invalid-url'), error => error.code === 'INVALID_URL' && error.http.status === null && error.http.stage === 'author-resolution');
});
