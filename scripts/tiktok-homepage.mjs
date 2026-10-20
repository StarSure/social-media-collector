import http from 'node:http';

const fail = (code, message) => Object.assign(new Error(message), { code });

function httpFailure(status, headers, stage, pathname) {
  const error = fail(`BLOCKED_HTTP_${status}`, `TikTok ${stage} returned HTTP ${status}; collection stopped without retry.`);
  error.http = { status, stage, path: pathname, retryAfter: headers['retry-after'] ?? null };
  return error;
}

export function validateTikTokOembed(data, profileUrl) {
  let author;
  try { author = parseTikTokHomepage(data?.author_url, 1); } catch { throw fail('OEMBED_IDENTITY_MISMATCH', 'The official embed response does not identify the requested profile.'); }
  if (author.url.toLowerCase() !== profileUrl.toLowerCase() || typeof data.html !== 'string'
      || data.html.match(/data-unique-id=["']([a-zA-Z0-9._]+)["']/)?.[1]?.toLowerCase() !== author.username.toLowerCase()
      || !/data-embed-type=["']creator["']/.test(data.html) || !/src=["']https:\/\/www\.tiktok\.com\/embed\.js["']/.test(data.html)) {
    throw fail('OEMBED_IDENTITY_MISMATCH', 'The official response does not contain a matching creator embed.');
  }
  return `<blockquote class="tiktok-embed" cite="${author.url}" data-unique-id="${author.username}" data-embed-type="creator" data-embed-from="oembed" style="max-width:780px;min-width:288px"><section><a href="${author.url}">@${author.username}</a></section></blockquote><script async src="https://www.tiktok.com/embed.js"></script>`;
}

export function parseTikTokHomepage(value, limitPerId) {
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_URL', 'Use a public TikTok profile HTTPS URL.'); }
  const match = /^\/@([a-zA-Z0-9._]+)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !['tiktok.com', 'www.tiktok.com'].includes(url.hostname) || url.port || url.username || url.password || !match) {
    throw fail('INVALID_URL', 'Use a public TikTok profile HTTPS URL.');
  }
  if (!Number.isSafeInteger(limitPerId) || limitPerId < 1 || limitPerId > 10) {
    throw fail('INVALID_LIMIT', 'TikTok official creator embeds expose a recent selection only; limitPerId must be 1–10.');
  }
  return { username: match[1], url: `https://www.tiktok.com/@${match[1]}`, embedUrl: `https://www.tiktok.com/embed/@${match[1]}`, limitPerId };
}

function integer(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : value;
  }
  return null;
}

export function normalizeTikTokVideo(item, { expectedUsername, expectedVideoId }) {
  const id = typeof item?.id === 'string' && /^\d+$/.test(item.id) ? item.id
    : Number.isSafeInteger(item?.id) && item.id >= 0 ? String(item.id) : null;
  if (!id || id !== expectedVideoId) throw fail('VIDEO_ID_MISMATCH', 'TikTok video ID is missing, imprecise or does not match the discovered link.');
  const username = item.author?.uniqueId;
  if (typeof username !== 'string' || username.toLowerCase() !== expectedUsername.toLowerCase()) {
    throw fail('AUTHOR_MISMATCH', 'TikTok video author does not match the requested profile.');
  }
  const metricFields = { playCount: 'playCount', likeCount: 'diggCount', commentCount: 'commentCount', shareCount: 'shareCount', collectCount: 'collectCount' };
  const metrics = {};
  const metricSources = {};
  for (const [output, field] of Object.entries(metricFields)) {
    const current = integer(item.statsV2?.[field]);
    const fallback = integer(item.stats?.[field]);
    metrics[output] = current ?? fallback;
    metricSources[output] = current !== null ? `statsV2.${field}` : fallback !== null ? `stats.${field}` : null;
  }
  return {
    platform: 'tiktok', type: 'video', id, username,
    url: `https://www.tiktok.com/@${username}/video/${id}`,
    description: typeof item.desc === 'string' ? item.desc : null,
    publishedAt: typeof item.createTime === 'string' || Number.isSafeInteger(item.createTime) ? String(item.createTime) : null,
    durationSeconds: integer(item.video?.duration), ...metrics, metricSources,
    metricPrecision: 'platform-reported; may be rounded',
  };
}

export function selectTikTokVideoLinks(links, username, limit) {
  const selected = new Map();
  for (const value of links) {
    let url;
    try { url = new URL(value); } catch { continue; }
    if (!['www.tiktok.com', 'tiktok.com'].includes(url.hostname) || url.protocol !== 'https:' || url.port || url.username || url.password) continue;
    const match = /^\/@([a-zA-Z0-9._]+)\/video\/(\d+)\/?$/.exec(url.pathname);
    if (!match) continue;
    if (match[1].toLowerCase() !== username.toLowerCase()) throw fail('AUTHOR_MISMATCH', 'The creator embed contains a video for another profile.');
    if (!selected.has(match[2])) selected.set(match[2], { id: match[2], url: `https://www.tiktok.com/@${match[1]}/video/${match[2]}` });
    if (selected.size >= limit) break;
  }
  return [...selected.values()];
}

export function selectTikTokEmbedVideoLinks(state, username, limit) {
  const links = [];
  for (const entry of Object.values(state?.source?.data ?? {})) {
    if (typeof entry?.userInfo?.uniqueId !== 'string' || entry.userInfo.uniqueId.toLowerCase() !== username.toLowerCase()) continue;
    if (entry.userInfo.privateAccount === true) throw fail('PRIVATE_PROFILE', 'The creator embed identifies a private profile; collection stopped.');
    if (entry.isReady !== true || entry.isError === true) continue;
    for (const item of Array.isArray(entry.videoList) ? entry.videoList : []) {
      if (item?.privateItem !== false) continue;
      if (typeof item.authorUniqueId !== 'string' || item.authorUniqueId.toLowerCase() !== username.toLowerCase()) throw fail('AUTHOR_MISMATCH', 'The creator embed video author does not match the requested profile.');
      const id = typeof item.id === 'string' && /^\d+$/.test(item.id) ? item.id : Number.isSafeInteger(item.id) && item.id >= 0 ? String(item.id) : null;
      if (!id) throw fail('VIDEO_ID_MISMATCH', 'The creator embed video ID is missing or imprecise.');
      links.push(`https://www.tiktok.com/@${item.authorUniqueId}/video/${id}`);
    }
  }
  return selectTikTokVideoLinks(links, username, limit);
}

async function checkPage(page) {
  const state = await page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const challenge = [...document.querySelectorAll('[id*="captcha"], [class*="captcha"], iframe[src*="captcha"]')].some(element => element.getClientRects().length > 0)
      || /verify (?:that )?you(?:'re| are) human|complete (?:the )?(?:security )?verification|验证您是真人|请完成安全验证/i.test(text);
    return { challenge, login: /\/login(?:\/|$)/.test(location.pathname) || /log in to (?:continue|view)|sign in to (?:continue|view)|登录后(?:查看|继续)|请先登录/i.test(text) };
  });
  if (state.challenge) throw fail('CHALLENGE_REQUIRED', 'TikTok verification required; anonymous collection stopped.');
  if (state.login) throw fail('LOGIN_REQUIRED', 'This page requires platform login; anonymous collection stopped.');
}

async function navigate(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const status = response?.status();
  if (status === 403 || status === 429) throw httpFailure(status, response.headers(), 'video-detail', new URL(url).pathname);
  if (!response || status >= 400) throw fail('HTTP_ERROR', `TikTok page unavailable (HTTP ${status ?? 'unknown'}).`);
  const actual = new URL(page.url());
  if (!['tiktok.com', 'www.tiktok.com'].includes(actual.hostname)) throw fail('UNEXPECTED_REDIRECT', 'TikTok redirected outside its public website.');
  await checkPage(page);
  return status;
}

// Each call owns fresh anonymous contexts; existing browser sessions are never reused.
export async function collectTikTokHomepage(browser, options) {
  const spec = parseTikTokHomepage(options.url, options.limitPerId);
  const result = { status: 'blocked', platform: 'tiktok', task: 'homepage-videos', loginUsed: false, records: [], sources: [], coverage: 'official-creator-embed recent selection, at most 10; full history and pagination unsupported', requestedCount: spec.limitPerId };
  const source = { url: spec.url, embedUrl: spec.embedUrl, requestedCount: spec.limitPerId, actualCount: 0, discoveredCount: 0, status: 'pending', loginUsed: false, coverage: result.coverage, evidence: { discovery: 'official-public-creator-embed-links', detail: 'page-embedded-json', scriptId: '__UNIVERSAL_DATA_FOR_REHYDRATION__', scope: 'webapp.video-detail' } };
  result.sources.push(source);
  const contexts = [];
  let server;
  let networkBlock;
  const watch = (page, stage = 'page-resource') => page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === 'https://www.tiktok.com' && url.pathname === '/embed.js') source.evidence.sdkHttpStatus = response.status();
    if (url.origin === 'https://www.tiktok.com' && url.pathname.toLowerCase() === new URL(spec.embedUrl).pathname.toLowerCase()) source.embedHttpStatus = response.status();
    if (['tiktok.com', 'www.tiktok.com'].includes(url.hostname) && [403, 429].includes(response.status())) {
      networkBlock ??= httpFailure(response.status(), response.headers(), url.pathname === '/embed.js' ? 'embed-sdk' : url.pathname.startsWith('/embed/') ? 'creator-iframe' : stage, url.pathname);
    }
  });
  try {
    const embedContext = await browser.newContext({ javaScriptEnabled: true }); contexts.push(embedContext);
    const detailContext = await browser.newContext({ javaScriptEnabled: false }); contexts.push(detailContext);
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(spec.url)}`;
    source.evidence.discovery = 'official-oembed-to-sdk-created-iframe';
    const response = await embedContext.request.get(oembedUrl, { timeout: 30000, maxRedirects: 0 });
    source.oembedHttpStatus = response.status();
    if ([403, 429].includes(response.status())) throw httpFailure(response.status(), response.headers(), 'oembed', '/oembed');
    if (!response.ok()) {
      const payload = await response.json().catch(() => null);
      if (payload && typeof payload === 'object') {
        source.oembedError = Object.fromEntries(['status_code', 'status_msg', 'message', 'error'].filter(key => ['string', 'number'].includes(typeof payload[key])).map(key => [key, String(payload[key]).slice(0, 500)]));
      }
      const error = fail('OEMBED_HTTP_ERROR', `The official oEmbed endpoint returned HTTP ${response.status()}.`);
      error.http = { status: response.status(), stage: 'oembed', path: '/oembed', retryAfter: response.headers()['retry-after'] ?? null };
      throw error;
    }
    const markup = validateTikTokOembed(await response.json(), spec.url);
    server = http.createServer((_request, reply) => {
      reply.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      reply.end(`<!doctype html><html><body>${markup}</body></html>`);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const embed = await embedContext.newPage(); watch(embed);
    await embed.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    let links = [];
    let frameObserved = false;
    // Use the frame the official SDK actually created; never invent its query or signatures.
    for (let pass = 0; pass < 20; pass++) {
      if (networkBlock) throw networkBlock;
      const frame = embed.frames().find(frame => {
        try { const url = new URL(frame.url()); return url.origin === 'https://www.tiktok.com' && url.pathname.toLowerCase() === new URL(spec.embedUrl).pathname.toLowerCase(); } catch { return false; }
      });
      if (frame) {
        frameObserved = true;
        const frameUrl = new URL(frame.url());
        source.evidence.frame = { origin: frameUrl.origin, path: frameUrl.pathname };
        await checkPage(frame);
        const state = await frame.evaluate(() => {
          let data;
          try { data = JSON.parse(document.getElementById('__FRONTITY_CONNECT_STATE__')?.textContent ?? ''); } catch { return null; }
          return { source: { data: Object.values(data?.source?.data ?? {}).map(entry => ({
            isReady: entry?.isReady, isError: entry?.isError,
            userInfo: { uniqueId: entry?.userInfo?.uniqueId, privateAccount: entry?.userInfo?.privateAccount },
            videoList: Array.isArray(entry?.videoList) ? entry.videoList.map(item => ({ id: item?.id, authorUniqueId: item?.authorUniqueId, privateItem: item?.privateItem })) : [],
          })) } };
        });
        const embeddedVideos = selectTikTokEmbedVideoLinks(state, spec.username, spec.limitPerId);
        if (embeddedVideos.length) {
          links = embeddedVideos.map(video => video.url);
          source.evidence.creatorScriptId = '__FRONTITY_CONNECT_STATE__';
          source.evidence.creatorList = 'source.data[matching-public-creator].videoList';
        } else if (!state) {
          links = await frame.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href).filter(url => /\/video\/\d+/.test(url)));
        }
      }
      if (links.length) break;
      await embed.waitForTimeout(500);
    }
    if (networkBlock) throw networkBlock;
    if (!frameObserved) throw fail('SDK_FRAME_UNAVAILABLE', 'The official SDK did not create a matching public creator frame within the bounded observation period.');
    const videos = selectTikTokVideoLinks(links, spec.username, spec.limitPerId);
    source.discoveredCount = videos.length;
    if (!videos.length) throw fail('NO_PUBLIC_VIDEO_LINKS', 'The official creator embed exposed no public video links; anonymous collection stopped.');
    const detail = await detailContext.newPage(); watch(detail, 'video-detail');
    for (const video of videos) {
      if (networkBlock) throw networkBlock;
      await navigate(detail, video.url);
      if (networkBlock) throw networkBlock;
      const item = await detail.evaluate(() => {
        let data;
        try { data = JSON.parse(document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent ?? ''); } catch { return null; }
        const item = data.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
        if (!item) return null;
        const stats = value => value && ({ playCount: value.playCount, diggCount: value.diggCount, commentCount: value.commentCount, shareCount: value.shareCount, collectCount: value.collectCount });
        // Exclude app context, media signatures and session-related page data.
        return { id: item.id, desc: item.desc, createTime: item.createTime, author: { uniqueId: item.author?.uniqueId }, video: { duration: item.video?.duration }, stats: stats(item.stats), statsV2: stats(item.statsV2) };
      });
      const record = normalizeTikTokVideo(item, { expectedUsername: spec.username, expectedVideoId: video.id });
      result.records.push({ ...record, collectedAt: new Date().toISOString(), sourceUrl: spec.url });
    }
    const missingMetrics = result.records.some(record => record.playCount === null || record.likeCount === null);
    result.status = result.records.length === spec.limitPerId && !missingMetrics ? 'completed' : 'partial';
    source.termination = missingMetrics ? 'required-metrics-unavailable' : result.records.length === spec.limitPerId ? 'requested-limit' : 'recent-selection-exhausted';
  } catch (error) {
    const failure = networkBlock ?? error;
    result.status = result.records.length ? 'partial' : 'blocked';
    source.termination = failure.code ?? 'COLLECTION_FAILED';
    source.error = failure.message;
    if (failure.http) source.http = failure.http;
  } finally {
    for (const context of contexts) await context.close();
    if (server) await new Promise(resolve => server.close(resolve));
    source.actualCount = result.records.length;
    source.status = result.status;
    result.recordCount = result.records.length;
    result.collectedAt = new Date().toISOString();
    source.collectedAt = result.collectedAt;
  }
  return { records: result.records, source };
}
