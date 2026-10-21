// Real Chrome DOM tests against synthetic, locally fulfilled pages. No social-site traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadPlaywright } from '../scripts/browser.mjs';
import { readInstagramPage } from '../scripts/instagram-page.mjs';
import { validateLocalSpec, collectWithContext, writeCollection } from '../scripts/local-browser.mjs';
import { instagramBrowserFixtures } from './instagram-browser-fixtures.mjs';
import { runAnonymousBrowserFixtures } from './anonymous-browser-fixtures.mjs';
import { runInstagramAnonymousBrowserFixtures } from './instagram-anonymous-browser-fixtures.mjs';
import { runLatestBrowserFixtures } from './latest-browser-fixtures.mjs';

const { playwright } = await loadPlaywright();
const candidates = [process.env.SOCIAL_BROWSER_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', playwright.chromium.executablePath()].filter(Boolean);
let executablePath;
for (const candidate of candidates) { try { await fs.access(candidate); executablePath = candidate; break; } catch {} }
if (!executablePath) throw new Error('Install Chrome or set SOCIAL_BROWSER_EXECUTABLE to run offline browser fixtures.');
const browser = await playwright.chromium.launch({ executablePath, headless: true });
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-collector-fixtures-'));
const checked = [];
try {
  const context = await browser.newContext();
  const fixtures = new Map();
  let fulfilled = 0;
  await context.route('**/*', async route => {
    const fixture = fixtures.get(route.request().url());
    if (!fixture) return route.abort();
    fulfilled++;
    return route.fulfill({ status: fixture.status ?? 200, contentType: 'text/html', body: fixture.html });
  });
  for (const [name, fixture] of Object.entries(instagramBrowserFixtures)) {
    fixtures.set(fixture.request.url, fixture);
    const page = await context.newPage();
    await page.goto(fixture.request.url);
    if (fixture.expectedError) await assert.rejects(readInstagramPage(page, fixture.request), error => error.code === fixture.expectedError);
    else {
      const result = await readInstagramPage(page, fixture.request);
      assert.equal(result.records.length, fixture.expectedCount, name);
      assert.ok(!JSON.stringify(result).includes('SYNTHETIC_DO_NOT_RETURN'));
      if (fixture.expectedCaption) assert.equal(result.records[0].caption, fixture.expectedCaption, name);
      if (fixture.expectedAuthor) assert.equal(result.records[0].author?.username, fixture.expectedAuthor, name);
      if (fixture.expectedCaptionSource) assert.equal(result.records[0].fieldSources.caption, fixture.expectedCaptionSource, name);
      if (fixture.expectedTexts) assert.deepEqual(result.records.map(record => record.text), fixture.expectedTexts, name);
      if (name === 'post') {
        assert.equal(result.records[0].caption, 'Synthetic caption only.');
        assert.equal(result.records[0].likeCount, 15);
        assert.equal(result.records[0].commentCount, null);
      }
      if (name === 'comments') assert.equal(result.records[0].text, 'Synthetic comment.');
    }
    checked.push(name);
    await page.close();
  }
  // Reset pages after the mismatch/login cases, then verify the complete CLI core.
  fixtures.clear();
  const profile = instagramBrowserFixtures.profile;
  const post = instagramBrowserFixtures.post;
  fixtures.set(profile.request.url, profile);
  fixtures.set(post.request.url, post);
  fixtures.set('https://www.instagram.com/reel/Sample02/', { html: post.html.replaceAll('/p/Sample01/', '/reel/Sample02/').replace('Synthetic caption only.', 'Second synthetic caption.') });
  const untouched = await context.newPage();
  const spec = validateLocalSpec({ platform: 'instagram', task: 'post', source: 'author-links', urls: [profile.request.url], limitPerId: 2 });
  const result = await collectWithContext(spec, context);
  assert.equal(result.status, 'completed', JSON.stringify(result.sources));
  assert.equal(result.recordCount, 2);
  assert.deepEqual(result.records.map(record => record.id).sort(), ['Sample01', 'Sample02']);
  assert.equal(context.pages().length, 1, 'Only collector-owned tabs are closed');
  assert.equal(untouched.url(), 'about:blank');
  const exported = await writeCollection(result, directory);
  const json = JSON.parse(await fs.readFile(exported.files.dataFile, 'utf8'));
  assert.equal(json.recordCount, 2);
  assert.equal(new Set(json.records.map(record => record.recordKey)).size, 2);
  checked.push('profile-to-two-posts-and-export');
  const comments = instagramBrowserFixtures.comments;
  fixtures.set(comments.request.url, comments);
  const commentResult = await collectWithContext(validateLocalSpec({ platform: 'instagram', task: 'comment', urls: [comments.request.url], limitPerId: 2 }), context);
  assert.equal(commentResult.status, 'partial');
  assert.equal(commentResult.recordCount, 1);
  assert.match(commentResult.records[0].recordKey, /:derived:/);
  checked.push('comments-shortfall-is-partial');
  fixtures.set(post.request.url, { status: 429, html: '<html><body>Slow down</body></html>' });
  const blocked = await collectWithContext(validateLocalSpec({ platform: 'instagram', task: 'post', urls: [post.request.url] }), context);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.recordCount, 0);
  assert.equal(blocked.sources[0].termination, 'RATE_LIMITED');
  checked.push('http429-is-blocked');
  await untouched.close();
  console.log(JSON.stringify({ status: 'passed', mode: 'offline-synthetic-fixtures', checked, fulfilledDocuments: fulfilled, livePlatformCollection: false }, null, 2));
} finally {
  await browser.close();
  await fs.rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify(await runAnonymousBrowserFixtures({ playwright, executablePath }), null, 2));
console.log(JSON.stringify(await runInstagramAnonymousBrowserFixtures({ playwright, executablePath }), null, 2));
console.log(JSON.stringify(await runLatestBrowserFixtures({ playwright, executablePath }), null, 2));
