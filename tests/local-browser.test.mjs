import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseLocalArguments, validateLocalSpec, parseLocalUrl, recordKey, csvCell, writeCollection, collectWithContext, assertExternalOutput } from '../scripts/local-browser.mjs';
import { skillRoot } from '../scripts/browser.mjs';

const post = { platform: 'instagram', task: 'post', urls: ['https://www.instagram.com/p/Example/'] };

test('local plans distinguish profile/posts/comments and require bounded list requests', () => {
  assert.equal(validateLocalSpec(post).source, 'links');
  assert.equal(validateLocalSpec({ platform: 'tiktok', task: 'author', urls: ['https://www.tiktok.com/@sample'] }).task, 'author');
  assert.equal(validateLocalSpec({ ...post, source: 'author-links', urls: ['https://www.instagram.com/sample/'], limitPerId: 3 }).limitPerId, 3);
  for (const input of [
    { ...post, task: 'comment' }, { ...post, limitPerId: 0 }, { ...post, limitPerId: '5' },
    { ...post, task: 'profile' }, { ...post, platform: 'tiktok' }, { ...post, source: 'keyword' },
    { ...post, source: 'author-links', urls: ['https://www.instagram.com/sample/'] }, { ...post, apiToken: 'not-used' },
    { ...post, outputDir: skillRoot },
  ]) assert.throws(() => validateLocalSpec(input));
});

test('URLs are canonicalized without tracking; foreign hosts, credentials, ports and wrong URL kinds are rejected', () => {
  assert.equal(parseLocalUrl('https://instagram.com/reels/Example/?igsh=tracking', 'instagram', 'post').url, 'https://www.instagram.com/reel/Example/');
  for (const url of ['https://instagram.com.evil.example/p/Example/', 'https://u:p@instagram.com/p/Example/', 'https://instagram.com:8443/p/Example/', 'http://instagram.com/p/Example/', 'https://www.instagram.com/accounts/login/']) {
    assert.throws(() => parseLocalUrl(url, 'instagram', 'post'));
  }
  assert.throws(() => validateLocalSpec({ ...post, urls: [post.urls[0], post.urls[0] + '?igsh=tracking'] }));
  assert.equal(validateLocalSpec({ ...post, urls: ['https://www.instagram.com/p/Example/', 'https://www.instagram.com/p/example/'] }).urls.length, 2);
});

test('CLI requires an explicit local browser endpoint for collection and rejects typos', () => {
  assert.equal(parseLocalArguments(['plan', '--spec', 'one.json']).command, 'plan');
  assert.throws(() => parseLocalArguments(['collect', '--spec', 'one.json']), /endpoint/);
  assert.throws(() => parseLocalArguments(['collect', '--spec', 'one.json', '--endpoint', 'http://elsewhere.example:9337']));
  assert.throws(() => parseLocalArguments(['plan', '--spec', 'one.json', '--cookie', 'x']));
});

test('comment deduplication is explicitly derived and does not collapse all comments under a post URL', () => {
  const comment = { platform: 'instagram', type: 'comment', id: null, url: post.urls[0], author: { username: 'sample' }, text: 'One', publishedAt: '2026-01-01T00:00:00Z' };
  assert.match(recordKey(comment), /:derived:/);
  assert.notEqual(recordKey(comment), recordKey({ ...comment, text: 'Two' }));
  assert.equal(recordKey(comment), recordKey(structuredClone(comment)));
  assert.throws(() => recordKey({ ...comment, publishedAt: null }));
});

test('JSON preserves values while CSV neutralizes formula cells and quotes multiline content', async () => {
  assert.equal(csvCell('=SUM(1,2)'), '"\'=SUM(1,2)"');
  assert.equal(csvCell('a"b\nc'), '"a""b\nc"');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'collector-export-'));
  try {
    const result = { status: 'partial', recordCount: 1, sources: [], records: [{ id: '9007199254740993', caption: '=1+1', likeCount: null }] };
    const first = await writeCollection(result, directory);
    const second = await writeCollection(result, directory);
    assert.notEqual(first.files.dataFile, second.files.dataFile);
    assert.deepEqual(JSON.parse(await fs.readFile(first.files.dataFile, 'utf8')), result);
    assert.match(await fs.readFile(first.files.csvFile, 'utf8'), /'=1\+1/);
    assert.equal(JSON.parse(await fs.readFile(first.files.reportFile, 'utf8')).records, undefined);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('HTTP429 stops the batch without retrying or touching existing browser pages', async () => {
  const navigations = [];
  let closed = 0;
  const page = { on() {}, async goto(url) { navigations.push(url); return { status: () => 429 }; }, async close() { closed++; } };
  const context = { async newPage() { return page; } };
  const result = await collectWithContext(validateLocalSpec({ ...post, urls: [post.urls[0], 'https://www.instagram.com/p/Another/'] }), context);
  assert.equal(result.status, 'blocked');
  assert.equal(result.sources[0].termination, 'RATE_LIMITED');
  assert.equal(result.processedSources, 1);
  assert.equal(navigations.length, 1);
  assert.equal(closed, 1);
  assert.equal(result.recordCount, 0);
});

test('output isolation follows symlinks, including not-yet-created children', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'collector-symlink-'));
  try {
    const alias = path.join(directory, 'alias');
    await fs.symlink(skillRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(assertExternalOutput(alias), error => error.code === 'INVALID_OUTPUT');
    await assert.rejects(assertExternalOutput(path.join(alias, 'not-created', 'child')), error => error.code === 'INVALID_OUTPUT');
    await assert.rejects(writeCollection({ records: [] }, alias), error => error.code === 'INVALID_OUTPUT');
    assert.equal(await assertExternalOutput(path.join(directory, 'external', 'child')), path.join(directory, 'external', 'child'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
