const fail = (code, message) => Object.assign(new Error(message), { code });

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
  if (status === 403 || status === 429) throw fail(`BLOCKED_HTTP_${status}`, `TikTok returned HTTP ${status}; collection stopped without retry.`);
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
  let networkBlock;
  const watch = page => page.on('response', response => {
    const url = new URL(response.url());
    if (['tiktok.com', 'www.tiktok.com'].includes(url.hostname) && [403, 429].includes(response.status())) {
      networkBlock ??= fail(`BLOCKED_HTTP_${response.status()}`, `TikTok request ${url.pathname} returned HTTP ${response.status()}; collection stopped without retry.`);
    }
  });
  try {
    const embedContext = await browser.newContext({ javaScriptEnabled: true }); contexts.push(embedContext);
    const detailContext = await browser.newContext({ javaScriptEnabled: false }); contexts.push(detailContext);
    const embed = await embedContext.newPage(); watch(embed);
    source.httpStatus = await navigate(embed, spec.embedUrl);
    let links = [];
    // Bounded observation, no scrolling, API calls, refreshes or alternate identities.
    for (let pass = 0; pass < 10; pass++) {
      if (networkBlock) throw networkBlock;
      await checkPage(embed);
      links = await embed.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href).filter(url => /\/video\/\d+/.test(url)));
      if (links.length) break;
      await embed.waitForTimeout(500);
    }
    if (networkBlock) throw networkBlock;
    const videos = selectTikTokVideoLinks(links, spec.username, spec.limitPerId);
    source.discoveredCount = videos.length;
    if (!videos.length) throw fail('NO_PUBLIC_VIDEO_LINKS', 'The official creator embed exposed no public video links; anonymous collection stopped.');
    const detail = await detailContext.newPage(); watch(detail);
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
  } finally {
    for (const context of contexts) await context.close();
    source.actualCount = result.records.length;
    source.status = result.status;
    result.recordCount = result.records.length;
    result.collectedAt = new Date().toISOString();
    source.collectedAt = result.collectedAt;
  }
  return { records: result.records, source };
}
