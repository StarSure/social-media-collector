import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnonymousArguments, validateAnonymousSpec } from '../scripts/anonymous-homepage.mjs';

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
