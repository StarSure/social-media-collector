// Independent real-Chrome forward checks; page routes fulfill synthetic responses only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../scripts/browser.mjs';
import { collectAnonymousHomepages, validateAnonymousSpec, findAnonymousBrowser } from '../scripts/anonymous-homepage.mjs';
import { createCheckpoint, saveCheckpoint, loadCheckpoint, writeAnonymousCollection } from '../scripts/collection-state.mjs';

const htmlJson = value => JSON.stringify(value).replaceAll('</script', '<\\/script');
const csvRows = text => {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') { if (quoted && text[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  const [columns, ...values] = rows;
  return values.map(values => Object.fromEntries(columns.map((column, index) => [column, values[index]])));
};

export async function runLatestBrowserFixtures(options = {}) {
  const playwright = options.playwright ?? (await loadPlaywright()).playwright;
  const executablePath = options.executablePath ?? await findAnonymousBrowser(playwright);
  const browser = await playwright.chromium.launch({ executablePath, headless: true });
  const untouched = await browser.newContext();
  await untouched.addCookies(['tiktok.com', 'instagram.com'].map(domain => ({ name: 'private_session', value: 'LATEST_PRIVATE_COOKIE', domain: '.' + domain, path: '/' })));
  const untouchedPage = await untouched.newPage();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'latest-independent-'));
  const outcomes = [];
  const tt = 'https://www.tiktok.com/@qa_tt', ig = 'https://www.instagram.com/qa_ig/';
  const epoch = 1792454400;
  const ttItems = Array.from({ length: 20 }, (_, index) => ({
    id: String(8800000000000000000n + BigInt(index)), author: { uniqueId: 'qa_tt' }, createTime: String(epoch - index),
    privateItem: false, video: { duration: 12 }, desc: index === 0 ? ' =FORMULA("synthetic")\nSecond line' : 'Synthetic video ' + index,
    statsV2: { playCount: String(1000 + index), diggCount: String(50 + index) },
  }));
  const ttPinned = { ...ttItems[0], id: '99001', createTime: '1000', isPinnedItem: true };
  const ttPhoto = { ...ttItems[0], id: '99002', imagePost: { images: [{}] } };
  const ttDetail = item => `<!doctype html><body><script type="application/json" id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${htmlJson({ __DEFAULT_SCOPE__: { 'webapp.video-detail': { itemInfo: { itemStruct: item } } } })}</script></body>`;
  const ttProfile = (natural = true) => `<!doctype html><body style="min-height:${natural ? 5000 : 300}px"><button aria-pressed="true">${natural ? 'Latest' : 'Popular'}</button><script type="application/json" id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${htmlJson({ __DEFAULT_SCOPE__: { 'webapp.user-detail': { userInfo: { user: { uniqueId: 'qa_tt', privateAccount: false } } } } })}</script>${[ttPinned, ttPhoto, ...ttItems].map(item => `<a style="display:block" href="${tt}/video/${item.id}">Video</a>`).join('')}${natural ? '<script>fetch("/api/post/item_list/?cursor=0&count=30");let more=false;addEventListener("scroll",()=>{if(!more){more=true;fetch("/api/post/item_list/?cursor=A&count=30")}})</script>' : ''}</body>`;
  const ttFixtures = (natural = true) => {
    const fixtures = new Map([[tt, { body: ttProfile(natural) }]]);
    fixtures.set('https://www.tiktok.com/api/post/item_list/?cursor=0&count=30', { json: { statusCode: 0, cursor: 'A', hasMore: true, itemList: [ttPinned, ttPhoto, ...ttItems.slice(0, 12), ttItems[0]] } });
    fixtures.set('https://www.tiktok.com/api/post/item_list/?cursor=A&count=30', { json: { statusCode: 0, cursor: 'B', hasMore: false, itemList: [ttItems[11], ...ttItems.slice(12)] } });
    for (const item of [ttPinned, ttPhoto, ...ttItems]) fixtures.set(`${tt}/video/${item.id}`, { body: ttDetail(item) });
    return fixtures;
  };
  const igNode = (code, index, overrides = {}) => ({ __typename: 'GraphVideo', shortcode: code, owner: { username: 'qa_ig' }, taken_at_timestamp: epoch - index, video_view_count: 2000 + index, edge_liked_by: { count: 80 + index }, edge_media_to_caption: { edges: [{ node: { text: 'Synthetic IG ' + code } }] }, ...overrides });
  const igItems = Array.from({ length: 20 }, (_, index) => igNode('Latest' + index, index));
  const igPinned = igNode('Pinned', 0, { taken_at_timestamp: 1000, is_pinned: true });
  const igPhoto = igNode('Photo', 0, { __typename: 'GraphImage' });
  const igHtml = value => `<!doctype html><body><script type="application/json">${htmlJson(value)}</script></body>`;
  const igTimeline = nodes => ({ data: { user: { username: 'qa_ig', is_private: false, edge_owner_to_timeline_media: { count: nodes.length, edges: nodes.map(node => ({ node })), page_info: { has_next_page: false, end_cursor: null } } } } });
  const igFixtures = (nodes = [igPinned, igPhoto, ...igItems]) => {
    const fixtures = new Map([[ig, { body: igHtml([igTimeline(nodes), igItems[0]]) }]]);
    for (const item of nodes) fixtures.set(`https://www.instagram.com/p/${item.shortcode}/embed/?cr=1`, { body: igHtml(item) });
    return fixtures;
  };
  const job = platform => validateAnonymousSpec({ platform, task: 'video', source: 'author-links', selection: 'latest', urls: [platform === 'tiktok' ? tt : ig], limitPerId: 20 });
  async function scenario(name, fixtures, spec, verify, settings = {}) {
    const requests = [], contexts = [];
    const owned = { newContext: async options => {
      assert.equal(Object.hasOwn(options, 'storageState'), false);
      const context = await browser.newContext(options); contexts.push(context);
      assert.deepEqual(await context.cookies(), []);
      context.on('request', request => {
        requests.push(request.url());
        assert.equal((request.headers().cookie ?? '').includes('LATEST_PRIVATE_COOKIE'), false);
      });
      return {
        route: (...args) => context.route(...args), close: () => context.close(),
        newPage: async () => {
          const page = await context.newPage();
          // Page routes take precedence over IG's production context guard and prevent leakage.
          await page.route('**/*', async route => {
            const fixture = fixtures.get(route.request().url());
            if (!fixture) return route.abort();
            return route.fulfill({ status: fixture.status ?? 200, headers: fixture.headers, contentType: fixture.json ? 'application/json' : 'text/html', body: fixture.json ? htmlJson(fixture.json) : fixture.body ?? '' });
          });
          return page;
        },
      };
    } };
    try {
      const result = await collectAnonymousHomepages(spec, owned, settings);
      assert.equal(browser.contexts().length, 1, 'owned contexts closed while prior context remains');
      assert.equal(untouchedPage.isClosed(), false);
      assert.equal((await untouched.cookies()).length, 2);
      assert.equal(result.loginUsed, false); assert.equal(result.userSessionRead, false);
      await verify(result, requests, owned);
      outcomes.push({ name, status: 'passed', collectionStatus: result.status, recordCount: result.recordCount });
    } catch (error) {
      outcomes.push({ name, status: 'failed', error: error.stack });
      for (const context of contexts) await context.close().catch(() => {});
    }
  }
  try {
    const saved = createCheckpoint(job('tiktok')), checkpointFile = path.join(directory, 'checkpoint.json'), progress = [];
    await scenario('tiktok-twenty-natural-pagination-pinned-dedup-photo-checkpoint-history', ttFixtures(), job('tiktok'), async (result, requests, owned) => {
      assert.equal(result.status, 'completed', JSON.stringify(result.sources)); assert.equal(result.recordCount, 20); assert.equal(result.acceptance.latest20Verified, true);
      assert.deepEqual(result.records.map(record => record.id), ttItems.map(item => item.id));
      assert.ok(requests.includes('https://www.tiktok.com/api/post/item_list/?cursor=A&count=30'));
      assert.equal(requests.some(url => /\/video\/9900[12]$/.test(url)), false);
      assert.ok(progress.some(count => count > 0 && count < 20));
      const loaded = await loadCheckpoint(checkpointFile, job('tiktok')), requestCount = requests.length;
      const resumed = await collectAnonymousHomepages(job('tiktok'), owned, { checkpoint: loaded });
      assert.equal(resumed.status, 'completed'); assert.equal(resumed.sources[0].resumed, true);
      assert.equal(requests.length, requestCount, 'complete checkpoint must not trigger additional requests');
      assert.deepEqual(resumed.records.map(record => record.collectedAt), result.records.map(record => record.collectedAt));
      const previous = { records: result.records.slice(0, 19).map(record => ({ ...record, collectedAt: '2026-10-20T00:00:00Z', playCount: record.playCount - 5, likeCount: record.likeCount - 1 })) };
      const output = await writeAnonymousCollection(result, directory, previous);
      const accounts = csvRows((await fs.readFile(output.files.accountsFile, 'utf8')).replace(/^\uFEFF/, ''));
      assert.equal(accounts[0].uniqueVideoCount, '20'); assert.equal(accounts[0].latestVerified, 'true');
      const changes = JSON.parse(await fs.readFile(output.files.changesJsonFile, 'utf8'));
      const changesCsv = csvRows((await fs.readFile(output.files.changesFile, 'utf8')).replace(/^\uFEFF/, ''));
      assert.equal(changes[0].playCountChange, 5); assert.equal(changes[0].likeCountChange, 1);
      assert.equal(changesCsv[0].playCountChange, '5'); assert.equal(changes.at(-1).baseline, 'new-video'); assert.equal(changes.at(-1).playCountPrevious, null); assert.equal(changesCsv.at(-1).playCountPrevious, '');
      assert.ok((await fs.readFile(output.files.csvFile, 'utf8')).includes("' =FORMULA"));
    }, { checkpoint: saved, onCheckpoint: async state => { const account = state.accounts[tt]; if (account.source.status === 'partial') progress.push(account.records.length); await saveCheckpoint(checkpointFile, state); } });
    await scenario('instagram-twenty-owned-timeline-pinned-photo-duplicate', igFixtures(), job('instagram'), result => {
      assert.equal(result.status, 'completed', JSON.stringify(result.sources)); assert.equal(result.recordCount, 20); assert.equal(result.acceptance.latest20Verified, true);
      assert.deepEqual(result.records.map(record => record.id), igItems.map(item => item.shortcode));
      assert.equal(result.records.every(record => record.playCount === null && record.viewCount >= 2000), true);
    });
    await scenario('tiktok-twenty-dom-links-without-feed-proof-remain-partial', ttFixtures(false), job('tiktok'), result => {
      assert.equal(result.recordCount, 20); assert.equal(result.status, 'partial'); assert.equal(result.sources[0].latestVerified, false); assert.equal(result.acceptance.latest20Verified, false);
    });
    await scenario('instagram-undated-candidate-outside-top-twenty-invalidates-latest-proof', igFixtures([...igItems, igNode('Undated', 0, { taken_at_timestamp: undefined })]), job('instagram'), result => {
      assert.equal(result.recordCount, 20); assert.equal(result.status, 'partial'); assert.equal(result.sources[0].latestVerified, false);
    });
    const rateLimited = ttFixtures(); rateLimited.set(`${tt}/video/${ttItems[1].id}`, { status: 429, headers: { 'retry-after': '75' }, body: '<body>Rate limited</body>' });
    await scenario('tiktok-detail-429-preserves-progress-and-skips-next-account', rateLimited, { ...job('tiktok'), urls: [tt, 'https://www.tiktok.com/@never_visit'] }, (result, requests) => {
      assert.equal(result.status, 'partial'); assert.equal(result.recordCount, 1); assert.equal(result.sources[0].termination, 'BLOCKED_HTTP_429'); assert.equal(result.sources[0].http.retryAfter, '75');
      assert.equal(requests.some(url => url.includes('never_visit')), false); assert.equal(result.accountSummary[1].status, 'skipped');
    });
    const login = igFixtures(); login.set(ig, { status: 302, headers: { location: 'https://www.instagram.com/accounts/login/?next=qa_ig' }, body: '' });
    await scenario('instagram-login-302-stops-next-account-and-details', login, { ...job('instagram'), urls: [ig, 'https://www.instagram.com/never_visit/'] }, (result, requests) => {
      assert.equal(result.status, 'blocked'); assert.equal(result.recordCount, 0); assert.equal(result.sources[0].termination, 'LOGIN_REQUIRED');
      assert.equal(requests.some(url => url.includes('/p/') || url.includes('never_visit')), false); assert.equal(result.accountSummary[1].status, 'skipped');
    });
    const igRateLimit = igFixtures(); igRateLimit.set(ig, { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 10:00:00 GMT' }, body: '<body>Rate limited</body>' });
    await scenario('instagram-profile-429-keeps-retry-after-and-skips-next-account', igRateLimit, { ...job('instagram'), urls: [ig, 'https://www.instagram.com/never_visit/'] }, (result, requests) => {
      assert.equal(result.status, 'blocked'); assert.equal(result.sources[0].termination, 'BLOCKED_HTTP_429');
      assert.equal(result.sources[0].http?.retryAfter ?? result.sources[0].diagnostics?.retryAfter, 'Wed, 21 Oct 2026 10:00:00 GMT');
      assert.equal(requests.some(url => url.includes('never_visit')), false);
    });
    const result = { status: 'passed', mode: 'offline-real-chrome-public-profile-fixtures', outcomes };
    assert.equal(outcomes.every(outcome => outcome.status === 'passed'), true, JSON.stringify(result, null, 2));
    return result;
  } finally { await browser.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLatestBrowserFixtures().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
