import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { normalizeTikTokProfile, readTikTokProfile } from '../scripts/tiktok-page.mjs';

const profile = () => ({ user: { id: '9007199254740993123', uniqueId: 'Example.Creator', nickname: 'Synthetic Creator', signature: 'Fixture bio', verified: true, privateAccount: false, avatarLarger: 'https://media.example/avatar.jpg' }, stats: { followerCount: 42, followingCount: 3, heartCount: 200, videoCount: 9 } });
const fixturePage = ({state, body = '', challenge = false, pathname = '/@Example.Creator'} = {}) => ({
  url: () => `https://www.tiktok.com${pathname}?token=DO_NOT_EXPORT`,
  evaluate: callback => runInNewContext(`(${callback.toString()})()`, {
    document: {
      body: {innerText: body},
      getElementById: id => id === '__UNIVERSAL_DATA_FOR_REHYDRATION__' && state ? {textContent: JSON.stringify(state)} : null,
      querySelectorAll: () => challenge ? [{getClientRects: () => [1]}] : [],
    }, location: {pathname},
  }),
});

test('normalizes the observed public SSR shape and preserves large string IDs', () => {
  const result = normalizeTikTokProfile(profile(), '@example.creator');
  assert.equal(result.id, '9007199254740993123');
  assert.equal(result.username, 'Example.Creator');
  assert.equal(result.followerCount, 42);
  assert.equal(result.likeCount, 200);
  assert.equal(result.url, 'https://www.tiktok.com/@Example.Creator');
  assert.equal(result.privateAccount, false);
});

test('missing and invalid counts remain null while genuine zero remains zero', () => {
  const fixture = profile();
  fixture.stats = { followerCount: 0, heart: 12, videoCount: -1, followingCount: '3' };
  const result = normalizeTikTokProfile(fixture, 'Example.Creator');
  assert.equal(result.followerCount, 0);
  assert.equal(result.followingCount, null);
  assert.equal(result.likeCount, 12);
  assert.equal(result.postCount, null);
  assert.equal(normalizeTikTokProfile({user: fixture.user}, 'Example.Creator').followerCount, null);
});

test('rejects a mismatched author, malformed structure and imprecise numeric IDs', () => {
  assert.throws(() => normalizeTikTokProfile(profile(), 'someone_else'), {code: 'USERNAME_MISMATCH'});
  assert.throws(() => normalizeTikTokProfile({}, 'Example.Creator'), {code: 'PROFILE_DATA_MISSING'});
  const fixture = profile(); fixture.user.id = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => normalizeTikTokProfile(fixture, 'Example.Creator'), {code: 'INVALID_PROFILE_ID'});
});

test('exports only public fields and removes sensitive avatar query parameters', () => {
  const fixture = profile();
  fixture.user.sessionToken = 'DO_NOT_EXPORT'; fixture.cookie = 'DO_NOT_EXPORT';
  fixture.user.avatarLarger = 'https://media.example/avatar.jpg?session_token=DO_NOT_EXPORT&width=100';
  const result = normalizeTikTokProfile(fixture, 'Example.Creator');
  assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT'), false);
  assert.equal(result.avatarUrl, 'https://media.example/avatar.jpg?width=100');
});

test('reader returns a source and timestamp without treating a login button as login-required', async () => {
  const page = fixturePage({state: {__DEFAULT_SCOPE__: {'webapp.user-detail': {userInfo: profile()}, 'webapp.app-context': {csrfToken:'DO_NOT_EXPORT'}}}, body: 'Synthetic Creator 登录'});
  const result = await readTikTokProfile(page, 'Example.Creator');
  assert.equal(result.records.length, 1);
  assert.ok(Number.isFinite(Date.parse(result.records[0].collectedAt)));
  assert.equal(result.evidence.source, 'page-embedded-json');
  assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT'), false);
});

test('page extraction recognizes explicit login and visible challenges while missing SSR fails', async () => {
  await assert.rejects(readTikTokProfile(fixturePage({body: 'Log in to continue'}), 'Example.Creator'), {code:'LOGIN_REQUIRED'});
  await assert.rejects(readTikTokProfile(fixturePage({pathname: '/login'}), 'Example.Creator'), {code:'LOGIN_REQUIRED'});
  await assert.rejects(readTikTokProfile(fixturePage({challenge:true}), 'Example.Creator'), {code:'CHALLENGE_REQUIRED'});
  await assert.rejects(readTikTokProfile(fixturePage({body:'Verify you are human'}), 'Example.Creator'), {code:'CHALLENGE_REQUIRED'});
  await assert.rejects(readTikTokProfile(fixturePage(), 'Example.Creator'), {code:'PROFILE_DATA_MISSING'});
});

test('reader distinguishes challenge, login, missing data and an unrelated origin', async () => {
  const page = observed => ({url: () => 'https://www.tiktok.com/@Example.Creator', evaluate: async () => observed});
  await assert.rejects(readTikTokProfile(page({challenge:true}), 'Example.Creator'), {code:'CHALLENGE_REQUIRED'});
  await assert.rejects(readTikTokProfile(page({loginRequired:true}), 'Example.Creator'), {code:'LOGIN_REQUIRED'});
  await assert.rejects(readTikTokProfile(page({}), 'Example.Creator'), {code:'PROFILE_DATA_MISSING'});
  await assert.rejects(readTikTokProfile({url:()=> 'https://www.tiktok.com.attacker.example/@Example.Creator'}, 'Example.Creator'), {code:'UNSUPPORTED_PAGE'});
});
