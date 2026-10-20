import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInstagramUrl, normalizeInstagramSnapshot, readInstagramPage, collectInstagramSnapshot } from '../scripts/instagram-page.mjs';
import { instagramBrowserFixtures } from './instagram-browser-fixtures.mjs';

const profile = { task: 'profile', url: 'https://www.instagram.com/sample.creator/' };
const post = { task: 'post', url: 'https://www.instagram.com/p/AbC_01/' };
const errorCode = code => error => error.code === code;

test('URL parser accepts only supported public Instagram targets', () => {
  assert.deepEqual(parseInstagramUrl('https://instagram.com/reel/AbC_01/?igsh=synthetic'), { kind: 'post', shortcode: 'AbC_01', url: 'https://www.instagram.com/reel/AbC_01/' });
  assert.equal(parseInstagramUrl(profile.url).username, 'sample.creator');
  for (const url of ['https://instagram.com.attacker.test/user/', 'https://www.instagram.com/accounts/', 'https://www.instagram.com/stories/user/1/', 'http://instagram.com/name/', 'https://user:password@instagram.com/name/']) assert.throws(() => parseInstagramUrl(url));
});

test('unknown profile counters remain null and abbreviated text is preserved', () => {
  const result = normalizeInstagramSnapshot({ heading: 'sample.creator', displayText: 'Sample Creator\n1.2K followers', og: { description: '1.2K Followers, 24 Posts' } }, profile);
  assert.equal(result.records[0].followerCount, null);
  assert.equal(result.records[0].postCount, null);
  assert.equal(result.records[0].id, null);
  assert.equal(result.records[0].displayText, 'Sample Creator\n1.2K followers');
});

test('profile OG fallback must identify the exact username', () => {
  assert.equal(normalizeInstagramSnapshot({ og: { title: 'Sample (@sample.creator) • Instagram' } }, profile).records.length, 1);
  assert.throws(() => normalizeInstagramSnapshot({ og: { title: 'Sample (@sample.creator.other)' } }, profile), errorCode('no-public-record'));
});

test('public profile biography comes only from matched JSON-LD description', () => {
  const record = normalizeInstagramSnapshot({ hasMatchedJson: true, json: { name: 'Sample', description: 'Public synthetic bio' }, og: { description: '1.2K Followers' } }, profile).records[0];
  assert.equal(record.bio, 'Public synthetic bio');
  assert.equal(record.fieldSources.bio, 'json-ld.description');
});

test('post shortcode is marked as shortcode and absent counts are not zero', () => {
  const record = normalizeInstagramSnapshot({ caption: 'Synthetic caption', json: { interactions: [{ type: 'LikeAction', count: '1.2K' }, { type: 'https://schema.org/CommentAction', count: 12 }] } }, post).records[0];
  assert.equal(record.id, 'AbC_01');
  assert.equal(record.idType, 'shortcode');
  assert.equal(record.likeCount, null);
  assert.equal(record.commentCount, 12);
  assert.equal(record.viewCount, null);
});

test('post metadata and media are whitelisted; sensitive query parameters are removed', () => {
  const record = normalizeInstagramSnapshot({ caption: 'Synthetic caption', session: { token: 'DO_NOT_RETURN' }, images: [{ url: 'https://images.example/p.jpg?token=DO_NOT_RETURN&size=large', alt: 'Synthetic image' }], video: 'javascript:alert(1)' }, post).records[0];
  assert.equal(record.images[0].url, 'https://images.example/p.jpg?size=large');
  assert.equal(record.videoUrl, null);
  assert.ok(!JSON.stringify(record).includes('DO_NOT_RETURN'));
});

test('mismatched canonical is rejected', () => {
  assert.throws(() => normalizeInstagramSnapshot({ canonical: 'https://www.instagram.com/p/Other/', caption: 'Wrong post' }, post), errorCode('canonical-mismatch'));
});

test('task must match target URL', () => {
  assert.throws(() => normalizeInstagramSnapshot({ heading: 'Synthetic' }, { ...profile, task: 'comment' }), errorCode('unsupported-task'));
});

test('comments require explicit author, text and valid time and do not invent IDs', () => {
  const result = normalizeInstagramSnapshot({ comments: [
    { authorUrl: 'https://www.instagram.com/commenter/', authorName: 'Commenter', text: 'Synthetic comment', publishedAt: '2026-01-01T00:00:00Z' },
    { authorUrl: 'https://elsewhere.example/commenter/', text: 'Not an Instagram author', publishedAt: '2026-01-01' },
    { authorUrl: 'https://www.instagram.com/commenter/', text: 'Missing time' },
  ] }, { ...post, task: 'comment', limitPerId: 10 });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, null);
  assert.equal(result.records[0].likeCount, null);
});

test('missing records and explicit page blockers are errors', () => {
  for (const code of ['login-required', 'challenge-required', 'not-found', 'canonical-mismatch']) assert.throws(() => normalizeInstagramSnapshot({ error: code }, post), errorCode(code));
  assert.throws(() => normalizeInstagramSnapshot({}, post), errorCode('no-public-record'));
  assert.throws(() => normalizeInstagramSnapshot({}, { ...post, task: 'comment' }), errorCode('no-public-record'));
});

test('outgoing links include only supported post/reel URLs', () => {
  const result = normalizeInstagramSnapshot({ heading: 'sample.creator', links: ['https://www.instagram.com/p/Synthetic/', 'https://www.instagram.com/p/Synthetic/?igsh=x', 'https://www.instagram.com/reel/Another/', profile.url, 'https://attacker.test/p/Fake/'] }, profile);
  assert.deepEqual(result.links, ['https://www.instagram.com/p/Synthetic/', 'https://www.instagram.com/reel/Another/']);
});

test('browser adapter evaluates the self-contained extractor and reports offline verification honestly', async () => {
  const page = { url: () => profile.url, evaluate: async (fn, options) => { assert.equal(fn, collectInstagramSnapshot); assert.equal(options.limitPerId, 20); return { heading: 'sample.creator' }; } };
  const result = await readInstagramPage(page, profile);
  assert.equal(result.evidence.liveVerified, false);
});

test('browser adapter refuses unrelated pages before evaluating', async () => {
  for (const url of ['https://attacker.test/sample.creator/', 'https://www.instagram.com/other/']) {
    await assert.rejects(readInstagramPage({ url: () => url, evaluate: () => assert.fail('should not evaluate') }, profile));
  }
});

test('browser adapter detects redirect to platform login', async () => {
  await assert.rejects(readInstagramPage({ url: () => 'https://www.instagram.com/accounts/login/', evaluate: async () => ({ error: 'login-required' }) }, profile), errorCode('login-required'));
});

test('offline fixtures cover DOM profile, post, comments, mismatches and blockers', () => {
  for (const name of ['profile', 'post', 'comments', 'mismatched', 'genericPostShell', 'genericProfileShell', 'postAlias', 'multiArticleJsonFallback', 'multiArticleTargetPermalink', 'multiArticleAmbiguous', 'duplicateComments', 'invalidCommentsBeforeValid', 'login', 'challenge']) assert.ok(instagramBrowserFixtures[name], name);
});

test('profile tooltip counters accept exact integers and keep abbreviated values unknown', () => {
  const record = normalizeInstagramSnapshot({ heading: 'sample.creator', profileCounters: { followerCount: '1,234', followingCount: '2.5K' } }, profile).records[0];
  assert.equal(record.followerCount, 1234);
  assert.equal(record.followingCount, null);
  assert.equal(record.fieldSources.followerCount, 'header.followers-link');
});

test('Instagram post shortcodes are case sensitive', () => {
  assert.throws(() => normalizeInstagramSnapshot({ canonical: 'https://www.instagram.com/p/abc_01/', caption: 'Wrong case' }, post), errorCode('canonical-mismatch'));
});

test('browser adapter validates task and limit before reading the DOM', async () => {
  const page = { url: () => profile.url, evaluate: () => assert.fail('should not evaluate') };
  await assert.rejects(readInstagramPage(page, { ...profile, task: 'unknown' }), errorCode('unsupported-task'));
  await assert.rejects(readInstagramPage(page, { ...profile, limitPerId: 0 }), errorCode('invalid-limit'));
});

test('generic Instagram OG image shells cannot become post records', () => {
  assert.throws(() => normalizeInstagramSnapshot({ og: { title: 'Instagram', image: 'https://images.example/logo.jpg' } }, post), errorCode('no-public-record'));
});

test('generic profile headings cannot prove the requested account identity', () => {
  for (const heading of ['Log in', 'Instagram', 'Create account']) assert.throws(() => normalizeInstagramSnapshot({ heading, og: { title: 'Instagram' } }, profile), errorCode('no-public-record'));
});

test('OG and header titles are preserved as raw text rather than invented display names', () => {
  const record = normalizeInstagramSnapshot({ heading: 'sample.creator', og: { title: 'Sample Creator (@sample.creator) • Instagram photos and videos' } }, profile).records[0];
  assert.equal(record.displayName, null);
  assert.equal(record.ogTitleText, 'Sample Creator (@sample.creator) • Instagram photos and videos');
  assert.equal(record.headingText, 'sample.creator');
});

test('same shortcode p/reel aliases are accepted without weakening case sensitivity', async () => {
  const canonical = 'https://www.instagram.com/reel/AbC_01/';
  assert.equal(normalizeInstagramSnapshot({ canonical, caption: 'Synthetic' }, post).records[0].shortcode, 'AbC_01');
  const result = await readInstagramPage({ url: () => canonical, evaluate: async () => ({ canonical, caption: 'Synthetic' }) }, post);
  assert.equal(result.records.length, 1);
  assert.throws(() => normalizeInstagramSnapshot({ canonical: 'https://www.instagram.com/reel/abc_01/', caption: 'Wrong case' }, post), errorCode('canonical-mismatch'));
});

test('invalid and duplicate comments cannot consume the unique record limit', () => {
  const comment = text => ({ authorUrl: 'https://www.instagram.com/commenter/', text, publishedAt: '2026-01-01T00:00:00Z' });
  const result = normalizeInstagramSnapshot({ comments: [{ text: 'invalid' }, comment('one'), comment('one'), comment('two')] }, { ...post, task: 'comment', limitPerId: 2 });
  assert.deepEqual(result.records.map(record => record.text), ['one', 'two']);
  assert.ok(result.records.every(record => record.id === null));
});
