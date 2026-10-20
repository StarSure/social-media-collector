// Independent Instagram synthetic main-document tests; unknown network is aborted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../scripts/browser.mjs';
import { collectAnonymousHomepages, validateAnonymousSpec, findAnonymousBrowser } from '../scripts/anonymous-homepage.mjs';
import { extractInstagramVideos, instagramScriptTexts } from '../scripts/instagram-homepage.mjs';
import { writeCollection } from '../scripts/local-browser.mjs';

export const instagramAnonymousHtml = media => {
  const contextJSON = JSON.stringify({ context: { graphql_media: media.map(shortcode_media => ({ shortcode_media })) } });
  const literal = JSON.stringify({ require: [['Ignored', null, null, []], ['PublicEmbed', 'handle', null, [{ contextJSON }]]] }).replaceAll('</script', '<\\/script');
  return `<!doctype html><html><body>Public embed<script>s.handle(${literal});</script></body></html>`;
};
export const instagramAnonymousMedia = (shortcode, overrides = {}) => ({
  __typename: 'GraphVideo', id: '9999999999999999999', shortcode, is_video: true,
  owner: { username: 'fixture_creator' },
  edge_media_to_caption: { edges: [{ node: { text: 'Synthetic "quote" (parenthesis) ] bracket \\ slash\ncaption' } }] },
  edge_liked_by: { count: 25 }, video_view_count: 1234,
  taken_at_timestamp: 1700000000, ...overrides,
});

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (c === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  return rows;
}

export async function runInstagramAnonymousBrowserFixtures(options = {}) {
  const playwright = options.playwright ?? (await loadPlaywright()).playwright;
  const executablePath = options.executablePath ?? await findAnonymousBrowser(playwright);
  const browser = await playwright.chromium.launch({ executablePath, headless: true });
  const preserved = await browser.newContext();
  await preserved.addCookies([{ name: 'private_session', value: 'IG_PRIVATE_COOKIE_SENTINEL', domain: '.instagram.com', path: '/' }]);
  const preservedPage = await preserved.newPage();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'instagram-independent-'));
  const outcomes = [];
  const sample = 'https://www.instagram.com/fixture_creator/';
  const spec = limitPerId => validateAnonymousSpec({ platform: 'instagram', task: 'video', source: 'author-links', urls: [sample], limitPerId });
  async function scenario(name, fixture, job, verify) {
    const created = [], requests = [];
    const owned = { newContext: async settings => {
      assert.equal(Object.hasOwn(settings, 'storageState'), false);
      const context = await browser.newContext(settings); created.push(context);
      assert.deepEqual(await context.cookies(), []);
      await context.route('**/*', route => {
        const request = route.request(); requests.push(request.url());
        assert.equal((request.headers().cookie ?? '').includes('IG_PRIVATE_COOKIE_SENTINEL'), false);
        const url = new URL(request.url());
        if (url.origin !== 'https://www.instagram.com' || request.resourceType() !== 'document') return route.abort();
        const response = typeof fixture === 'function' ? fixture(url) : fixture;
        if (!response) return route.abort();
        return route.fulfill({ status: response.status ?? 200, contentType: 'text/html', body: response.body ?? '' });
      });
      return context;
    } };
    try {
      const result = await collectAnonymousHomepages(job, owned);
      assert.equal(browser.contexts().length, 1);
      assert.equal(preservedPage.isClosed(), false);
      assert.equal((await preserved.cookies())[0].value, 'IG_PRIVATE_COOKIE_SENTINEL');
      assert.equal(result.loginUsed, false); assert.equal(result.userSessionRead, false);
      assert.match(result.coverage, /no full-history/);
      assert.equal(JSON.stringify(result).includes('IG_PRIVATE_COOKIE_SENTINEL'), false);
      await verify(result, requests);
      outcomes.push({ name, status: 'passed', collectionStatus: result.status, recordCount: result.recordCount });
    } catch (error) {
      outcomes.push({ name, status: 'failed', error: error.stack });
      for (const context of created) await context.close().catch(() => {});
    }
  }
  try {
    globalThis.__igExtractorExecuted = false;
    const literalHtml = instagramAnonymousHtml([instagramAnonymousMedia('Safe')]);
    const malicious = 's.handle((()=>{globalThis.__igExtractorExecuted=true;return {}})());';
    const extracted = extractInstagramVideos([...instagramScriptTexts(literalHtml), malicious, 'globalThis.__igExtractorExecuted=true;'], { expectedUsername: 'fixture_creator', limitPerId: 1 });
    assert.equal(globalThis.__igExtractorExecuted, false); delete globalThis.__igExtractorExecuted;
    assert.equal(extracted[0].shortcode, 'Safe');
    outcomes.push({ name: 'extractor-never-evaluates-script-expressions', status: 'passed' });
    const caption = instagramAnonymousMedia('Aa_1').edge_media_to_caption.edges[0].node.text;
    await scenario('nested-json-caption-escaping-long-id-view-not-play', { body: instagramAnonymousHtml([instagramAnonymousMedia('Aa_1')]) }, spec(1), async result => {
      assert.equal(result.recordCount, 1, JSON.stringify(result.sources));
      const record = result.records[0];
      assert.equal(record.id, 'Aa_1'); assert.equal(record.idType, 'shortcode'); assert.equal(record.shortcode, 'Aa_1');
      assert.equal(record.viewCount, 1234); assert.equal(record.playCount, null); assert.equal(record.likeCount, 25);
      assert.equal(result.status, 'completed');
      assert.equal(record.description ?? record.caption, caption);
      const exported = await writeCollection(result, directory);
      const json = JSON.parse(await fs.readFile(exported.files.dataFile, 'utf8'));
      const csv = await fs.readFile(exported.files.csvFile, 'utf8');
      assert.equal(json.records[0].viewCount, 1234); assert.equal(json.records[0].playCount, null);
      const [columns, ...rows] = parseCsv(csv.replace(/^\uFEFF/, ''));
      assert.equal(rows.length, json.records.length);
      for (let i = 0; i < rows.length; i++) for (let j = 0; j < columns.length; j++) {
        const value = json.records[i][columns[j]];
        assert.equal(rows[i][j], value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
    });
    const valid = [instagramAnonymousMedia('AbC', { id: '9999999999999999991' }), instagramAnonymousMedia('abc', { id: '9999999999999999992' })];
    await scenario('wrong-author-and-photo-dont-consume-case-sensitive-quota', { body: instagramAnonymousHtml([
      instagramAnonymousMedia('WRONG', { owner: { username: 'other_creator' } }),
      instagramAnonymousMedia('PHOTO', { __typename: 'GraphImage', is_video: false }), ...valid,
    ]) }, spec(2), result => {
      assert.equal(result.recordCount, 2, JSON.stringify(result.sources));
      assert.deepEqual(result.records.map(record => record.shortcode), ['AbC', 'abc']);
      assert.equal(result.records.some(record => ['WRONG', 'PHOTO'].includes(record.shortcode)), false);
    });
    await scenario('genuine-zero-play-remains-separate-from-view', { body: instagramAnonymousHtml([instagramAnonymousMedia('Zero', { video_play_count: 0, video_view_count: 15, edge_liked_by: { count: 0 } })]) }, spec(1), result => {
      assert.equal(result.records[0].playCount, 0); assert.equal(result.records[0].viewCount, 15); assert.equal(result.records[0].likeCount, 0);
      assert.equal(result.status, 'completed');
    });
    await scenario('both-play-and-view-missing-remains-partial', { body: instagramAnonymousHtml([instagramAnonymousMedia('Unknown', { video_view_count: undefined })]) }, spec(1), result => {
      assert.equal(result.records[0].playCount, null); assert.equal(result.records[0].viewCount, null);
      assert.equal(result.status, 'partial');
    });
    await scenario('detail-hidden-counts-clear-profile-counts', url => ({ body: instagramAnonymousHtml([instagramAnonymousMedia('Hidden', url.pathname.includes('/p/') ? { like_and_view_counts_disabled: true, video_view_count: 0, edge_liked_by: { count: 0 } } : {})]) }), spec(1), result => {
      assert.equal(result.records[0].playCount, null); assert.equal(result.records[0].viewCount, null); assert.equal(result.records[0].likeCount, null);
      assert.equal(result.status, 'partial');
    });
    await scenario('ig-normal-shortfall-continues-next-account', url => {
      const next = url.pathname.includes('next_creator') || url.pathname.includes('/p/Next');
      const media = next ? [instagramAnonymousMedia('Next1', { owner: { username: 'next_creator' } }), instagramAnonymousMedia('Next2', { owner: { username: 'next_creator' } })] : [instagramAnonymousMedia('First')];
      return { body: instagramAnonymousHtml(media) };
    }, { ...spec(2), urls: [sample, 'https://www.instagram.com/next_creator/'] }, result => {
      assert.equal(result.status, 'partial'); assert.equal(result.processedSources, 2); assert.equal(result.recordCount, 3);
    });
    await scenario('visible-human-challenge-blocks-even-with-ssr-data', { body: instagramAnonymousHtml([instagramAnonymousMedia('Challenge')]).replace('<body>', '<body><p>Verify that you are human</p>') }, spec(1), result => {
      assert.equal(result.status, 'blocked'); assert.equal(result.recordCount, 0); assert.equal(result.sources[0].termination, 'CHALLENGE_REQUIRED');
    });
    for (const status of [403, 429]) await scenario(`empty-http${status}-keeps-diagnosis`, { status }, spec(1), result => {
      assert.equal(result.status, 'blocked'); assert.equal(result.sources[0].termination, `BLOCKED_HTTP_${status}`, JSON.stringify(result.sources));
    });
    for (const status of [403, 429]) await scenario(`http${status}-stops-batch`, { status, body: '<body>Access unavailable</body>' }, { ...spec(1), urls: [sample, 'https://www.instagram.com/next_creator/'] }, (result, requests) => {
      assert.equal(result.status, 'blocked'); assert.equal(result.processedSources, 1);
      assert.equal(requests.some(url => url.includes('next_creator')), false);
      assert.equal(result.sources[0].termination, `BLOCKED_HTTP_${status}`);
    });
    const result = { status: 'passed', mode: 'offline-only-all-network-intercepted', outcomes };
    assert.equal(outcomes.every(outcome => outcome.status === 'passed'), true, JSON.stringify(result, null, 2));
    return result;
  } finally { await browser.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runInstagramAnonymousBrowserFixtures().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
