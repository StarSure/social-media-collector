// Independent offline Chrome acceptance. API requests are stubbed; unknown page requests abort.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../scripts/browser.mjs';
import { collectAnonymousHomepages, validateAnonymousSpec, findAnonymousBrowser } from '../scripts/anonymous-homepage.mjs';
import { writeCollection } from '../scripts/local-browser.mjs';

export async function runAnonymousBrowserFixtures(options = {}) {
  const playwright = options.playwright ?? (await loadPlaywright()).playwright;
  const executablePath = options.executablePath ?? await findAnonymousBrowser(playwright);
  const browser = await playwright.chromium.launch({ executablePath, headless: true });
  const untouched = await browser.newContext();
  await untouched.addCookies([{ name: 'private_session', value: 'PRIVATE_COOKIE_SENTINEL', domain: '.tiktok.com', path: '/' }]);
  const untouchedPage = await untouched.newPage();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anonymous-independent-'));
  const outcomes = [];
  const sample = 'https://www.tiktok.com/@fixture_creator';
  const id1 = '9999999999999999991', id2 = '9999999999999999992';
  const sdkQuery = '?sdk_sentinel=created-by-sdk&token=SDK_DO_NOT_EXPORT';
  const sdk = `const block=document.querySelector('blockquote[data-embed-type="creator"]');const frame=document.createElement('iframe');frame.src='https://www.tiktok.com/embed/@'+block.dataset.uniqueId+${JSON.stringify(sdkQuery)};block.replaceWith(frame);`;
  const oembedUrl = profile => `https://www.tiktok.com/oembed?url=${encodeURIComponent(profile)}`;
  const oembedData = profile => ({ author_url: profile, html: `<blockquote data-unique-id="${new URL(profile).pathname.slice(2)}" data-embed-type="creator"></blockquote><script src="https://www.tiktok.com/embed.js"></script><script src="https://untrusted.example/not-allowed.js"></script>` });
  const embed = ids => `<!doctype html><body>${ids.map(id => `<a href="${sample}/video/${id}">Video</a>`).join('')}</body>`;
  const detail = (id, change = {}) => `<!doctype html><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ secret: 'PRIVATE_STATE_SENTINEL', __DEFAULT_SCOPE__: { 'webapp.video-detail': { itemInfo: { itemStruct: { id, author: { uniqueId: 'fixture_creator' }, desc: 'Synthetic only', createTime: '1700000000', stats: { playCount: 0, diggCount: 5 }, ...change } } } } })}</script></body>`;
  const spec = () => validateAnonymousSpec({ platform: 'tiktok', task: 'video', source: 'author-links', urls: [sample], limitPerId: 2 });
  const csvParse = text => {
    const rows = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
      else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
      else if (c === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    return rows;
  };
  async function scenario(name, fixtures, job, verify) {
    const requests = [], created = [];
    const owned = { newContext: async settings => {
      assert.equal(Object.hasOwn(settings, 'storageState'), false);
      const context = await browser.newContext(settings); created.push(context);
      assert.deepEqual(await context.cookies(), []);
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        const childFrame = Boolean(req.frame().parentFrame());
        requests.push({ url: req.url(), cookie: req.headers().cookie ?? '', childFrame, kind: 'browser' });
        assert.equal((req.headers().cookie ?? '').includes('PRIVATE_COOKIE_SENTINEL'), false);
        if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/' && !childFrame && req.resourceType() === 'document') return route.continue();
        let fixture = fixtures.get(req.url());
        if (url.origin === 'https://www.tiktok.com' && url.pathname.startsWith('/embed/@')) {
          assert.equal(childFrame, true, 'creator embed must load in the SDK-created child frame');
          assert.equal(url.search, sdkQuery, 'collector must use the real SDK-created query unchanged');
          fixture = fixtures.get(url.origin + url.pathname);
        }
        if (!fixture) return route.abort();
        return route.fulfill({ status: fixture.status ?? 200, headers: fixture.headers, contentType: fixture.contentType ?? 'text/html', body: fixture.body ?? '' });
      });
      return {
        newPage: () => context.newPage(), close: () => context.close(),
        request: { get: async (url, settings) => {
          requests.push({ url, kind: 'api-stub' });
          assert.deepEqual(await context.cookies(), []);
          assert.equal(settings.maxRedirects, 0);
          const fixture = fixtures.get(url);
          assert.ok(fixture, `Unmatched API request blocked: ${url}`);
          const status = fixture.status ?? 200;
          return { status: () => status, ok: () => status >= 200 && status < 300, headers: () => fixture.headers ?? {}, json: async () => fixture.json };
        } },
      };
    } };
    try {
      const result = await collectAnonymousHomepages(job, owned);
      assert.equal(browser.contexts().length, 1, 'only owned contexts are closed');
      assert.equal(untouchedPage.isClosed(), false);
      assert.equal((await untouched.cookies())[0].value, 'PRIVATE_COOKIE_SENTINEL');
      assert.equal(result.loginUsed, false); assert.equal(result.userSessionRead, false);
      assert.match(result.coverage, /at most 10.*no full-history/);
      assert.equal(JSON.stringify(result).includes('PRIVATE_STATE_SENTINEL'), false);
      assert.equal(JSON.stringify(result).includes('SDK_DO_NOT_EXPORT'), false);
      assert.equal(requests.some(request => request.url.includes('untrusted.example')), false, 'untrusted oEmbed HTML is never rendered');
      await verify(result, requests);
      outcomes.push({ name, status: 'passed', recordCount: result.recordCount, collectionStatus: result.status });
    } catch (error) {
      outcomes.push({ name, status: 'failed', error: error.stack });
      for (const context of created) await context.close().catch(() => {});
    }
  }
  const addProfile = (fixtures, profile, body) => {
    fixtures.set(oembedUrl(profile), { json: oembedData(profile) });
    fixtures.set(`https://www.tiktok.com/embed/${new URL(profile).pathname.slice(1)}`, { body });
  };
  const base = () => {
    const fixtures = new Map([
      ['https://www.tiktok.com/embed.js', { contentType: 'application/javascript', body: sdk }],
      [`${sample}/video/${id1}`, { body: detail(id1) }], [`${sample}/video/${id2}`, { body: detail(id2) }],
    ]);
    addProfile(fixtures, sample, embed([id1, id1, id2]));
    return fixtures;
  };
  try {
    await scenario('fresh-context-dedupe-metrics-json-csv', base(), spec(), async (result, requests) => {
      assert.equal(result.status, 'completed', JSON.stringify(result.sources)); assert.equal(result.recordCount, 2);
      assert.deepEqual(result.records.map(record => record.id), [id1, id2]); assert.equal(result.records[0].playCount, 0);
      assert.equal(requests[0].url, oembedUrl(sample)); assert.equal(requests[0].kind, 'api-stub');
      assert.ok(requests.some(request => request.url.startsWith('http://127.0.0.1:') && !request.childFrame));
      assert.ok(requests.some(request => request.url === 'https://www.tiktok.com/embed/@fixture_creator' + sdkQuery && request.childFrame));
      const exported = await writeCollection(result, directory);
      const json = JSON.parse(await fs.readFile(exported.files.dataFile, 'utf8'));
      const [columns, ...rows] = csvParse((await fs.readFile(exported.files.csvFile, 'utf8')).replace(/^\uFEFF/, ''));
      assert.equal(rows.length, json.records.length); assert.equal(columns.length, Object.keys(json.records[0]).length);
      for (let i = 0; i < rows.length; i++) for (let j = 0; j < columns.length; j++) {
        const value = json.records[i][columns[j]];
        assert.equal(rows[i][j], value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
    });
    const ssr = base();
    const privateId = '9999999999999999993';
    const frontity = { source: { data: { [`/embed/@fixture_creator${sdkQuery}`]: {
      isReady: true, isError: false,
      userInfo: { uniqueId: 'fixture_creator', privateAccount: false },
      videoList: [
        { id: privateId, authorUniqueId: 'fixture_creator', privateItem: true, playCount: 999, desc: 'PRIVATE_VIDEO_MUST_NOT_BE_EXPORTED' },
        { id: id1, authorUniqueId: 'fixture_creator', privateItem: false, playCount: 0, desc: 'Public first' },
        { id: id1, authorUniqueId: 'fixture_creator', privateItem: false, playCount: 0, desc: 'Duplicate first' },
        { id: id2, authorUniqueId: 'fixture_creator', privateItem: false, playCount: 15, desc: 'Public second' },
      ],
    } } } };
    addProfile(ssr, sample, `<!doctype html><body><script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify(frontity)}</script></body>`);
    await scenario('sdk-iframe-ssr-without-dom-links-skips-private-before-quota', ssr, spec(), (result, requests) => {
      assert.equal(result.status, 'completed', JSON.stringify(result.sources));
      assert.equal(result.recordCount, 2);
      assert.deepEqual(result.records.map(record => record.id), [id1, id2]);
      assert.equal(result.sources[0].discoveredCount, 2);
      const details = requests.filter(request => request.kind === 'browser' && request.url.includes('/video/')).map(request => request.url);
      assert.deepEqual(details, [`${sample}/video/${id1}`, `${sample}/video/${id2}`]);
      assert.equal(details.some(url => url.includes(privateId)), false);
      assert.equal(JSON.stringify(result).includes('PRIVATE_VIDEO_MUST_NOT_BE_EXPORTED'), false);
    });
    const missing = base(); missing.set(`${sample}/video/${id2}`, { body: detail(id2, { stats: { playCount: 10 } }) });
    await scenario('missing-like-is-null-partial', missing, spec(), result => { assert.equal(result.status, 'partial'); assert.equal(result.records[1].likeCount, null); });
    const short = base(); addProfile(short, sample, embed([id1]));
    await scenario('recent-selection-shortfall-is-partial', short, spec(), result => { assert.equal(result.status, 'partial'); assert.equal(result.recordCount, 1); });
    const multi = base(); addProfile(multi, sample, embed([id1]));
    const next = 'https://www.tiktok.com/@next_creator';
    addProfile(multi, next, embed(['8881', '8882']).replaceAll(sample, next));
    for (const id of ['8881', '8882']) multi.set(`${next}/video/${id}`, { body: detail(id, { author: { uniqueId: 'next_creator' } }) });
    await scenario('normal-partial-does-not-stop-next-account', multi, { ...spec(), urls: [sample, next] }, result => { assert.equal(result.status, 'partial'); assert.equal(result.processedSources, 2); assert.equal(result.recordCount, 3); });
    for (const status of [403, 429]) {
      const denied = base(); denied.set(`${sample}/video/${id2}`, { status, headers: { 'retry-after': '900' }, body: '<!doctype html><body>Access denied or rate limited</body>' });
      await scenario(`http${status}-stops-whole-batch`, denied, { ...spec(), urls: [sample, next] }, (result, requests) => {
        assert.equal(result.status, 'partial'); assert.equal(result.processedSources, 1);
        assert.equal(requests.some(request => request.url.includes('next_creator')), false);
        assert.equal(result.sources[0].termination, `BLOCKED_HTTP_${status}`);
        assert.deepEqual(result.sources[0].http, { status, stage: 'video-detail', path: `/@fixture_creator/video/${id2}`, retryAfter: '900' });
      });
    }
    for (const status of [403, 429]) {
      const denied = base(); denied.set(`${sample}/video/${id2}`, { status, headers: { 'retry-after': '120' } });
      await scenario(`empty-http${status}-keeps-diagnosis`, denied, spec(), result => {
        assert.equal(result.status, 'partial'); assert.equal(result.sources[0].termination, `BLOCKED_HTTP_${status}`, JSON.stringify(result.sources));
        assert.equal(result.sources[0].http.stage, 'video-detail'); assert.equal(result.sources[0].http.retryAfter, '120');
      });
    }
    for (const [name, change, code] of [['wrong-author', { author: { uniqueId: 'other_creator' } }, 'AUTHOR_MISMATCH'], ['wrong-video-id', { id: '123' }, 'VIDEO_ID_MISMATCH']]) {
      const invalid = base(); invalid.set(`${sample}/video/${id1}`, { body: detail(id1, change) });
      await scenario(name, invalid, spec(), result => { assert.equal(result.status, 'blocked'); assert.equal(result.recordCount, 0); assert.equal(result.sources[0].termination, code); });
    }
    const challenge = base(); addProfile(challenge, sample, '<body>Verify that you are human</body>');
    await scenario('challenge-stops-before-detail', challenge, spec(), (result, requests) => {
      assert.equal(result.status, 'blocked'); assert.equal(requests.some(request => request.url.includes('/video/')), false); assert.equal(result.sources[0].termination, 'CHALLENGE_REQUIRED');
    });
    for (const status of [403, 429]) for (const stage of ['oembed', 'creator-iframe']) {
      const denied = base();
      denied.set(stage === 'oembed' ? oembedUrl(sample) : 'https://www.tiktok.com/embed/@fixture_creator', { status, headers: { 'retry-after': '3600' }, body: '<body>Access unavailable</body>' });
      await scenario(`${stage}-http${status}-stops-before-details`, denied, { ...spec(), urls: [sample, next] }, (result, requests) => {
        assert.equal(result.status, 'blocked'); assert.equal(result.recordCount, 0); assert.equal(result.processedSources, 1);
        assert.equal(requests.some(request => request.url.includes('/video/') || request.url.includes('next_creator')), false);
        assert.equal(result.sources[0].termination, `BLOCKED_HTTP_${status}`);
        assert.deepEqual(result.sources[0].http, { status, stage, path: stage === 'oembed' ? '/oembed' : '/embed/@fixture_creator', retryAfter: '3600' });
      });
    }
    const result = { status: 'passed', mode: 'offline-only-api-stub-and-intercepted-browser', outcomes };
    assert.equal(outcomes.every(outcome => outcome.status === 'passed'), true, JSON.stringify(result, null, 2));
    return result;
  } finally { await browser.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAnonymousBrowserFixtures().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
