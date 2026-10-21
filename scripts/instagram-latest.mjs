import { parseInstagramUrl } from './instagram-page.mjs';
import { extractInstagramListVideos, instagramScriptTexts, instagramTimelineEvidence, instagramResponseError, instagramPageBarrier, readInstagramEmbed, readInstagramVideoDetail, extractInstagramVideoAuthor } from './instagram-homepage.mjs';

const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
function failure(error, state) {
  if (error.name === 'TimeoutError') error.code = 'NAVIGATION_TIMEOUT';
  const observed = state.documentHttp?.stage === state.stage ? state.documentHttp : null;
  error.http ??= { status: error.httpStatus ?? observed?.status ?? null, stage: error.stage ?? state.stage, path: error.path ?? state.path ?? null, retryAfter: error.retryAfter ?? observed?.retryAfter ?? null };
  return error;
}
const firstParty = url => /(^|\.)(?:instagram\.com|cdninstagram\.com|facebook\.com|fbcdn\.net)$/.test(new URL(url).hostname);
const sorted = records => [...records].sort((a, b) => (b.publishedAt ?? -1) - (a.publishedAt ?? -1) || a.id.localeCompare(b.id));
const knownCount = value => Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && /^\d+$/.test(value);
const completeMetrics = record => (knownCount(record.playCount) || knownCount(record.viewCount)) && knownCount(record.likeCount);

async function guardContext(context, page, state) {
  const stop = error => {
    state.error ??= failure(error, state);
    if (typeof page.close === 'function') void page.close().catch(() => {});
  };
  state.stop = stop;
  await context.route('**/*', async route => {
    if (state.error) return route.abort();
    const request = route.request();
    if (request.resourceType() === 'document') {
      const code = instagramPageBarrier(request.url());
      if (code) { stop(fail(code, 'Instagram requires login or verification; stopped.', { stage: state.stage, path: new URL(request.url()).pathname, httpStatus: null, retryAfter: null })); return route.abort(); }
    }
    return route.continue();
  });
  page.on('response', response => {
    if (!firstParty(response.url())) return;
    const kind = response.request().resourceType();
    if (kind === 'document') state.documentHttp = { stage: state.stage, status: response.status(), retryAfter: response.headers()['retry-after'] ?? null };
    if (state.httpEvents.length < 50 && (kind === 'document' || ['xhr', 'fetch'].includes(kind) && /json/i.test(response.headers()['content-type'] ?? ''))) state.httpEvents.push({ stage: state.stage, path: new URL(response.url()).pathname, status: response.status(), retryAfter: response.headers()['retry-after'] ?? null });
    if ([403, 429].includes(response.status())) { stop(instagramResponseError(response, state.stage)); return; }
    const redirect = response.headers().location;
    for (const url of [response.url(), ...(redirect ? [new URL(redirect, response.url()).href] : [])]) {
      const code = instagramPageBarrier(url);
      if (code) { stop(fail(code, 'Instagram redirected to login or verification; stopped.', { stage: state.stage, path: new URL(url).pathname, httpStatus: response.status(), retryAfter: response.headers()['retry-after'] ?? null })); return; }
    }
  });
}

async function checkPage(page, state) {
  if (state.error) throw state.error;
  const current = new URL(page.url());
  if (!['instagram.com', 'www.instagram.com'].includes(current.hostname)) throw fail('UNEXPECTED_REDIRECT', 'Instagram left its public website.', { stage: state.stage, path: current.pathname });
  const code = instagramPageBarrier(current.href);
  if (code) throw fail(code, 'Instagram requires login or verification; stopped.', { stage: state.stage, path: current.pathname });
  const observed = await page.evaluate(() => ({
    text: document.body?.innerText ?? '',
    challenge: [...document.querySelectorAll('iframe[src*="captcha"],[id*="captcha"]')].some(node => node.getClientRects().length > 0),
    scripts: [...document.querySelectorAll('script:not([src])')].map(node => node.textContent ?? ''),
    links: [...new Set([...document.querySelectorAll('a[href]')].map(node => node.href))].filter(value => /^https:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+\//.test(value)),
  }));
  if (observed.challenge || /(?:confirm|verify) (?:that )?you(?:'re| are) human|请完成安全验证/i.test(observed.text)) throw fail('CHALLENGE_REQUIRED', 'Instagram requires verification; stopped.', { stage: state.stage, path: current.pathname });
  if (/log in to (?:see|continue|view)|登录后(?:查看|继续)|登录 Instagram\s*(?:手机号|手机号码|账号|电子邮箱)/i.test(observed.text)) throw fail('LOGIN_REQUIRED', 'Instagram requires login; stopped.', { stage: state.stage, path: current.pathname });
  return observed;
}

export function reusableInstagramRecord(record, discovered) {
  return record?.id === discovered.id && record.shortcode === discovered.shortcode
    && record.username?.toLowerCase() === discovered.username?.toLowerCase()
    && Number.isSafeInteger(discovered.publishedAt) && record.publishedAt === discovered.publishedAt
    && typeof record.collectedAt === 'string' && completeMetrics(record)
    && !Object.values(record.fieldSources ?? {}).some(value => value?.endsWith?.(':hidden'));
}

export async function collectInstagramLatest(browser, { url, limitPerId, onProgress, resumeRecords = [] }) {
  const target = parseInstagramUrl(url);
  if (target.kind !== 'profile') throw fail('INVALID_URL', 'Use a public Instagram profile URL.');
  if (!Number.isSafeInteger(limitPerId) || limitPerId < 1 || limitPerId > 100) throw fail('INVALID_LIMIT', 'Request 1–100 latest Instagram videos.');
  if (!Array.isArray(resumeRecords)) throw fail('INVALID_RESUME_RECORDS', 'resumeRecords must be an array.');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('INVALID_PROGRESS_CALLBACK', 'onProgress must be a function.');
  const records = [], discovered = new Map(), pagination = new Map();
  const source = { url: target.url, requestedCount: limitPerId, actualCount: 0, status: 'blocked', latestVerified: false, loginUsed: false, scrollCount: 0, discoveryCount: 0, ordering: 'publication time descending; pinned entries do not override time', httpEvents: [], coverage: 'ordinary guest profile, naturally observed DOM/JSON; latest range requires complete owned timeline evidence' };
  const state = { stage: 'profile-discovery', path: new URL(target.url).pathname, error: null, httpEvents: source.httpEvents };
  const pending = new Set();
  let context, page, timer, completeList = false, completeVideoIds = new Set();
  const consume = (scripts, label) => {
    const evidence = instagramTimelineEvidence(scripts, target.username);
    if (evidence.privateProfile) throw fail('PRIVATE_PROFILE', 'The requested Instagram profile is private.', { stage: state.stage, path: new URL(target.url).pathname });
    const current = extractInstagramListVideos(scripts, { expectedUsername: target.username, limitPerId: 100 });
    for (const record of current) {
      const prior = discovered.get(record.id);
      discovered.set(record.id, prior ? { ...prior, ...record, fieldSources: { ...prior.fieldSources, ...record.fieldSources } } : record);
    }
    completeList ||= evidence.completeLists.length > 0;
    if (evidence.completeLists.length) { completeVideoIds = new Set(evidence.completeLists.at(-1).videoShortcodes); }
    for (const item of evidence.pagination) pagination.set(item.path, { ...item, source: label });
  };
  try {
    context = await browser.newContext({ javaScriptEnabled: true });
    page = await context.newPage();
    await guardContext(context, page, state);
    timer = setTimeout(() => { state.error ??= fail('TIME_BUDGET_EXCEEDED', 'Instagram collection reached its 120 second budget.', { stage: state.stage, path: new URL(page.url()).pathname }); void page.close().catch(() => {}); }, 120000);
    page.on('response', response => {
      if (state.stage !== 'profile-discovery' || state.error || !firstParty(response.url()) || response.status() !== 200
        || !/json/i.test(response.headers()['content-type'] ?? '') || !['xhr', 'fetch'].includes(response.request().resourceType())) return;
      const task = (async () => {
        const value = await response.json();
        if (state.stage !== 'profile-discovery' || state.error) return;
        if (/login_required|challenge_required|checkpoint_required/.test(value?.message ?? '')) { state.error ??= fail(/login/.test(value.message) ? 'LOGIN_REQUIRED' : 'CHALLENGE_REQUIRED', 'Instagram requires login or verification.', { stage: state.stage, path: new URL(response.url()).pathname }); return; }
        const text = JSON.stringify(value);
        if (/edge_owner_to_timeline_media|shortcode_media|graphql_media|"media_type"|"GraphVideo"/.test(text)) consume([text], `network:${new URL(response.url()).pathname}`);
      })();
      pending.add(task); void task.catch(error => { if (error.code === 'PRIVATE_PROFILE') { state.stop(error); return; } source.ignoredJsonResponses = (source.ignoredJsonResponses ?? 0) + 1; }).finally(() => pending.delete(task));
    });
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (state.error) throw state.error;
    const httpError = instagramResponseError(response, state.stage);
    if (httpError) throw httpError;
    source.httpStatus = response.status();
    // Check the URL before reading scripts or scrolling; localized login pages are barriers too.
    let observed = await checkPage(page, state);
    consume(instagramScriptTexts(await response.text()), 'main-document');
    consume(observed.scripts, 'rendered-inline-scripts');
    source.observedPostLinks = observed.links.length;
    let noNew = 0;
    for (let scroll = 0; scroll < 60 && discovered.size < limitPerId && !completeList; scroll++) {
      if (state.error) throw state.error;
      const before = discovered.size;
      await page.evaluate(() => window.scrollBy(0, Math.max(innerHeight * 0.9, 700)));
      await page.waitForTimeout(1000);
      await Promise.race([Promise.allSettled([...pending]), page.waitForTimeout(250)]);
      observed = await checkPage(page, state);
      consume(observed.scripts, 'rendered-inline-scripts');
      source.observedPostLinks = Math.max(source.observedPostLinks, observed.links.length);
      source.scrollCount++;
      noNew = discovered.size === before ? noNew + 1 : 0;
      if (noNew >= 3) { source.discoveryTermination = 'three-scrolls-without-new-videos'; break; }
    }
    // Freeze before selecting: a delayed JSON body must never change evidence behind a selected snapshot.
    state.stage = 'discovery-freeze';
    await Promise.race([Promise.allSettled([...pending]), page.waitForTimeout(100)]);
    if (state.error) throw state.error;
    source.discoveryCount = discovered.size;
    source.pagination = [...pagination.values()];
    const selected = sorted(discovered.values()).slice(0, limitPerId);
    const completeTimes = [...completeVideoIds].every(id => Number.isSafeInteger(discovered.get(id)?.publishedAt));
    const covered = [...completeVideoIds].every(id => discovered.has(id)) && [...discovered.keys()].every(id => completeVideoIds.has(id));
    source.latestVerified = completeList && completeTimes && covered;
    source.latestEvidence = completeList ? 'complete-owned-timeline-count-and-terminal-page' : null;
    state.stage = 'video-detail';
    for (const record of selected) {
      if (state.error) throw state.error;
      state.path = `/p/${record.shortcode}/embed/`;
      const cached = resumeRecords.find(item => reusableInstagramRecord(item, record));
      let combined;
      if (cached) combined = { ...cached, isPinned: record.isPinned, restoredFromCheckpoint: true };
      else {
        const detail = await readInstagramVideoDetail(page, { shortcode: record.shortcode, expectedUsername: target.username });
        if (state.error) throw state.error;
        if (detail.publishedAt !== null && record.publishedAt !== null && detail.publishedAt !== record.publishedAt) source.latestVerified = false;
        combined = { ...record, fieldSources: { ...record.fieldSources } };
        for (const key of ['publishedAt', 'playCount', 'viewCount', 'likeCount', 'commentCount']) {
          if (combined.fieldSources[key]?.endsWith(':hidden')) continue;
          if (detail[key] !== null || detail.fieldSources[key]?.endsWith(':hidden')) { combined[key] = detail[key]; combined.fieldSources[key] = `detailEmbed.${detail.fieldSources[key]}`; }
        }
        combined.collectedAt = new Date().toISOString();
      }
      records.push({ ...combined, sourceUrl: target.url });
      records.sort((a, b) => (b.publishedAt ?? -1) - (a.publishedAt ?? -1));
      if (onProgress) await onProgress(records.map(item => ({ ...item, fieldSources: { ...item.fieldSources } })));
    }
    if (records.some(record => !Number.isSafeInteger(record.publishedAt))) source.latestVerified = false;
    const complete = records.length === limitPerId && source.latestVerified && records.every(completeMetrics);
    source.status = complete ? 'completed' : 'partial';
    source.termination = !source.latestVerified ? 'latest-order-unverified' : records.length < limitPerId ? 'list-exhausted' : !records.every(completeMetrics) ? 'required-metrics-unavailable' : 'requested-limit';
  } catch (caught) {
    const error = failure(state.error ?? caught, state);
    source.status = records.length ? 'partial' : 'blocked';
    source.termination = error.code ?? 'COLLECTION_FAILED';
    source.error = error.message;
    source.http = error.http;
    source.diagnostics = { stage: error.http.stage, path: error.http.path, httpStatus: error.http.status, retryAfter: error.http.retryAfter };
  } finally {
    clearTimeout(timer);
    if (context) await context.close();
    source.actualCount = records.length;
    source.discoveryCount = discovered.size;
    source.collectedAt = new Date().toISOString();
  }
  return { records, source };
}

export async function resolveInstagramVideoAuthor(browser, videoUrl) {
  let target;
  try {
    const u = new URL(videoUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'reels' && parts.length === 2) u.pathname = `/reel/${parts[1]}/`;
    target = parseInstagramUrl(u.href);
  } catch { throw failure(fail('INVALID_URL', 'Use an actual Instagram /p/, /reel/, or /reels/ video URL.'), { stage: 'author-resolution', path: null }); }
  if (target.kind !== 'post') throw failure(fail('INVALID_URL', 'Use an actual Instagram video URL.'), { stage: 'author-resolution', path: new URL(videoUrl).pathname });
  const context = await browser.newContext({ javaScriptEnabled: true });
  const state = { stage: 'author-resolution', path: `/p/${target.shortcode}/embed/`, error: null, httpEvents: [] };
  try {
    const page = await context.newPage(); await guardContext(context, page, state);
    const detail = await readInstagramEmbed(page, `https://www.instagram.com/p/${target.shortcode}/embed/?cr=1`, { stage: state.stage });
    if (state.error) throw state.error;
    const username = extractInstagramVideoAuthor(detail.scripts, target.shortcode);
    return { url: `https://www.instagram.com/${username}/`, username, videoId: target.shortcode, sourceVideoUrl: videoUrl, httpStatus: detail.status };
  } catch (error) { throw failure(state.error ?? error, state); }
  finally { await context.close(); }
}
