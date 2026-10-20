import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArguments, validateEndpoint, validateSpec, hostMatches, summarizeTab, redactReport, runtimeMismatches, skillRoot } from './browser.mjs';

const catalog = JSON.parse(await fs.readFile(path.join(skillRoot, 'references/platforms.json'), 'utf8'));
const note = { platform: '小红书', task: 'note', keywords: ['小学语文'], limit: 25, mode: 'api' };
const file = fileURLToPath(new URL('./browser.mjs', import.meta.url));

test('keyword plan resolves canonical platform, original collectBy, and historic evidence without claiming a new run', () => {
  const plan = validateSpec(note, catalog);
  assert.equal(plan.spec.platform, 'xiaohongshu');
  assert.equal(plan.spec.source, 'keyword');
  assert.equal(plan.spec.mode, 'api');
  assert.equal(plan.route, '/xiaohongshu/batch-collect/note');
  assert.equal(plan.collectionStarted, false);
  assert.equal(plan.currentRequestVerified, false);
  assert.ok(plan.verification.cases.length);
});

test('B站 uses keywords plural; source-free comments retain null instead of fabricated collectBy', () => {
  assert.equal(validateSpec({ platform: 'B站', task: 'video', keywords: ['数学'], limit: 2 }, catalog).spec.source, 'keywords');
  const comment = validateSpec({ platform: 'xiaohongshu', task: 'comment', urls: ['https://www.xiaohongshu.com/explore/123'], limitPerId: 5 }, catalog);
  assert.equal(comment.spec.source, null);
  assert.throws(() => validateSpec({ platform: 'xiaohongshu', task: 'comment' }, catalog), /requires urls/);
});

test('foreign platform links, lookalike hosts, URLs with credentials, and share text are rejected', () => {
  for (const url of ['https://www.douyin.com/video/1', 'https://www.xiaohongshu.com.attacker.example/x', 'https://name:password@www.xiaohongshu.com/explore/1', 'javascript:alert(1)', '复制这条 https://www.xiaohongshu.com/explore/1']) {
    assert.throws(() => validateSpec({ platform: 'xiaohongshu', task: 'note', urls: [url] }, catalog));
  }
  assert.equal(hostMatches('a.example.com', ['*.example.com']), true);
  assert.equal(hostMatches('notexample.com', ['*.example.com']), false);
});

test('limits and source inputs cannot be silently discarded', () => {
  for (const change of [
    { limit: 0 }, { limit: -1 }, { limit: 1.2 }, { limit: '25' }, { limitPerId: Number.MAX_SAFE_INTEGER + 1 },
    { source: 'links' }, { source: 'api' }, { mode: 'headless' }, { keywords: [] }, { keywords: ['同词', '同词'] },
    { urls: ['https://www.xiaohongshu.com/explore/1'] }, { unexpected: true }
  ]) assert.throws(() => validateSpec({ ...note, ...change }, catalog));
  assert.throws(() => validateSpec({ platform: 'xiaohongshu', task: 'note', source: 'author-links' }, catalog), /requires urls/);
  assert.throws(() => validateSpec({ platform: 'xiaohongshu', task: 'note' }, catalog), /Specify source/);
});

test('page-based collection preserves context requirement and original RPA-only modes', () => {
  const hidden = validateSpec({ platform: 'xingtu', task: 'author-search', source: 'search', limit: 2 }, catalog);
  assert.equal(hidden.requiresPageContext, true);
  const home = validateSpec({ platform: 'xiaohongshu', task: 'note', source: 'homefeed', mode: 'rpa', limit: 3 }, catalog);
  assert.equal(home.requiresPageContext, true);
  assert.throws(() => validateSpec({ platform: 'xiaohongshu', task: 'note', source: 'homefeed', mode: 'api' }, catalog), /RPA-only/);
  assert.equal(home.currentRequestVerified, false);
});

test('unknown platforms/tasks/fields and output inside skill are rejected', () => {
  for (const change of [{ platform: 'unknown' }, { task: 'upload' }, { outputDir: skillRoot }, { outputDir: path.join(skillRoot, 'assets/output') }]) assert.throws(() => validateSpec({ ...note, ...change }, catalog));
});

test('endpoint restrictions keep browser control local and avoid credential-bearing queries', () => {
  for (const endpoint of ['https://127.0.0.1:9336', 'http://example.com:9336', 'http://127.0.0.1:9336/json', 'http://user:pass@localhost:9336', 'http://localhost:9336?token=x']) assert.throws(() => validateEndpoint(endpoint));
  assert.equal(validateEndpoint('http://127.0.0.1:9337'), 'http://127.0.0.1:9337');
  assert.equal(validateEndpoint('http://[::1]:9337'), 'http://[::1]:9337');
});

test('CLI parser catches typos, duplicates, unsupported run, and missing values', () => {
  assert.deepEqual(parseArguments(['plan', '--spec=/tmp/one.json']), { command: 'plan', options: { spec: '/tmp/one.json' } });
  for (const args of [['run', '--spec', '/tmp/x'], ['plan'], ['preflight', '--cookie', 'secret'], ['plan', '--spec'], ['launch', '--port', '9337', '--port', '9338']]) assert.throws(() => parseArguments(args));
});

test('read-only tab inventory and emitted plans omit token-bearing URL parameters and personal titles', () => {
  assert.deepEqual(summarizeTab('https://www.xiaohongshu.com/explore/private-id?xsec_token=secret#secret', catalog), { platform: 'xiaohongshu', origin: 'https://www.xiaohongshu.com' });
  assert.equal(summarizeTab('chrome://settings', catalog), null);
  const clean = redactReport({ spec: { urls: ['https://www.xiaohongshu.com/explore/1?xsec_token=secret&xsec_source=pc'], token: 'secret' } });
  assert.ok(!JSON.stringify(clean).includes('secret'));
  assert.deepEqual(clean.spec.urls, ['https://www.xiaohongshu.com/explore/1']);
});

test('offline CLI consumes a real spec without any browser dependency and rejects unsupported requests', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'social-collector-test-'));
  try {
    const specPath = path.join(temp, 'spec.json');
    await fs.writeFile(specPath, JSON.stringify(note));
    const result = spawnSync(process.execPath, [file, 'plan', '--spec', specPath], { encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_PACKAGE: '/nonexistent' } });
    assert.equal(result.status, 0, result.stderr);
    const planned = JSON.parse(result.stdout);
    assert.equal(planned.spec.source, 'keyword');
    assert.equal(planned.status, 'planned-only');
    assert.equal(planned.collectionStarted, false);
    await fs.writeFile(specPath, JSON.stringify({ ...note, typoLimit: 99 }));
    const invalid = spawnSync(process.execPath, [file, 'plan', '--spec', specPath], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Unknown spec field/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});


test('runtime identity rejects changed collection bundles even when backend hash remains identical', () => {
  const expected = [{ path: 'local-backend.js', sha256: 'backend-same' }, { path: 'chunks/sidepanel.js', sha256: 'new-pagination-fix' }, { path: 'manifest.json', sha256: 'manifest-same' }];
  const oldRuntime = [{ path: 'local-backend.js', sha256: 'backend-same' }, { path: 'chunks/sidepanel.js', sha256: 'old-pagination-bug' }, { path: 'manifest.json', sha256: 'manifest-same' }];
  assert.deepEqual(runtimeMismatches(expected, oldRuntime), ['chunks/sidepanel.js']);
  assert.deepEqual(runtimeMismatches(expected, expected), []);
  assert.deepEqual(runtimeMismatches(expected, []), expected.map(item => item.path));
});

test('Instagram is routed to the local collector without connecting to the original extension', () => {
  assert.throws(() => validateSpec({ platform: 'instagram', task: 'profile', urls: ['https://www.instagram.com/sample/'] }, catalog), /local-browser/);
  const result = spawnSync(process.execPath, [file, 'open', '--platform', 'instagram', '--task', 'profile', '--endpoint', 'http://127.0.0.1:1'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'local-collector-required');
});
