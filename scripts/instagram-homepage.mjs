const fail = (code, message) => Object.assign(new Error(message), { code });

function count(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value;
  }
  return null;
}

function literalArgument(text, start) {
  let index = start;
  while (/\s/.test(text[index] ?? '') && index < text.length) index++;
  if (!['{', '[', '"'].includes(text[index])) return null;
  const begin = index;
  const stack = [];
  let quoted = false;
  let escaped = false;
  for (; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') { quoted = false; if (!stack.length) return text.slice(begin, index + 1); }
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) return null;
      if (!stack.length) return text.slice(begin, index + 1);
    }
  }
  return null;
}

export function instagramScriptTexts(html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => match[1]);
}

function instagramJsonRoots(scriptTexts) {
  const roots = [];
  scriptTexts.forEach((script, index) => {
    const text = typeof script === 'string' ? script : script?.text;
    if (typeof text !== 'string') return;
    try { roots.push({ value: JSON.parse(text), path: `script[${index}].json` }); } catch { /* Not a JSON script. */ }
    for (const match of text.matchAll(/\bs\.handle\(\s*/g)) {
      const literal = literalArgument(text, match.index + match[0].length);
      if (!literal) continue;
      try { roots.push({ value: JSON.parse(literal), path: `script[${index}].ServerJS.handle.json-literal` }); } catch { /* Expressions and invalid JSON are not executed. */ }
    }
  });
  return roots;
}

// Parse JSON and literal ServerJS arguments only. Never evaluate the script wrapper.
function extractInstagramRecords(scriptTexts, { expectedUsername, limitPerId, expectedShortcode }, maximum) {
  if (typeof expectedUsername !== 'string' || !/^[a-zA-Z0-9._]+$/.test(expectedUsername)) throw fail('INVALID_USERNAME', 'A public Instagram username is required.');
  if (!Number.isSafeInteger(limitPerId) || limitPerId < 1 || limitPerId > maximum) throw fail('INVALID_LIMIT', `Instagram parsing is limited to 1–${maximum} videos.`);
  if (expectedShortcode !== undefined && (typeof expectedShortcode !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(expectedShortcode))) throw fail('INVALID_SHORTCODE', 'Use the exact discovered Instagram shortcode.');
  const roots = instagramJsonRoots(scriptTexts);
  const records = new Map();
  let visited = 0;
  const walk = (value, path, depth = 0) => {
    if (++visited > 150000 || depth > 80) throw fail('PAGE_DATA_TOO_LARGE', 'Instagram embedded data exceeds the bounded parser limit.');
    if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
      let decoded;
      try { decoded = JSON.parse(value); } catch { return; }
      walk(decoded, path + '.decoded-json-string', depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((node, index) => walk(node, `${path}[${index}]`, depth + 1)); return; }
    const code = value.shortcode ?? value.code;
    const ownerKey = value.owner ? 'owner' : 'user';
    const owner = value[ownerKey];
    const video = (value.__typename === 'GraphVideo' || value.is_video === true || value.media_type === 2) && value.is_recommendation !== true && value.is_recommended !== true;
    if (value.is_private !== true && owner?.is_private !== true && typeof code === 'string' && /^[a-zA-Z0-9_-]+$/.test(code) && video && (!expectedShortcode || code === expectedShortcode)) {
      if (typeof owner?.username === 'string' && owner.username.toLowerCase() === expectedUsername.toLowerCase()) {
        const fieldSources = { username: `${path}.${ownerKey}.username`, id: `${path}.${value.shortcode ? 'shortcode' : 'code'}` };
        const metric = (output, candidates) => {
          if (value.like_and_view_counts_disabled === true && ['playCount', 'viewCount', 'likeCount'].includes(output)) {
            fieldSources[output] = `${path}.like_and_view_counts_disabled:hidden`;
            return null;
          }
          for (const candidate of candidates) {
            const raw = candidate.split('.').reduce((node, key) => node?.[key], value);
            const parsed = count(raw);
            if (parsed !== null) { fieldSources[output] = `${path}.${candidate}`; return parsed; }
          }
          fieldSources[output] = null;
          return null;
        };
        const edges = value.edge_media_to_caption?.edges;
        const caption = typeof value.caption === 'string' ? value.caption
          : typeof value.caption?.text === 'string' ? value.caption.text
          : typeof edges?.[0]?.node?.text === 'string' ? edges[0].node.text : null;
        const timeKey = ['taken_at_timestamp', 'taken_at'].find(key => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 253402300799);
        fieldSources.publishedAt = timeKey ? `${path}.${timeKey}` : null;
        const pinKey = typeof value.is_pinned === 'boolean' ? 'is_pinned' : Array.isArray(value.pinned_for_users) ? 'pinned_for_users' : null;
        fieldSources.isPinned = pinKey ? `${path}.${pinKey}` : null;
        const record = {
          publishedAt: timeKey ? value[timeKey] : null,
          isPinned: pinKey ? (pinKey === 'is_pinned' ? value.is_pinned : value.pinned_for_users.length > 0) : null,
          platform: 'instagram', type: 'video', id: code, idType: 'shortcode', shortcode: code, username: owner.username,
          url: `https://www.instagram.com/p/${code}/`, caption,
          playCount: metric('playCount', ['play_count', 'video_play_count']),
          viewCount: metric('viewCount', ['view_count', 'video_view_count']),
          likeCount: metric('likeCount', ['like_count', 'edge_media_preview_like.count', 'edge_liked_by.count']),
          commentCount: metric('commentCount', ['edge_media_to_comment.count']),
          fieldSources,
        };
        const existing = records.get(code);
        if (!existing) records.set(code, record);
        else for (const key of ['publishedAt', 'isPinned', 'playCount', 'viewCount', 'likeCount', 'commentCount']) {
          if (record.fieldSources[key]?.endsWith(':hidden')) { existing[key] = null; existing.fieldSources[key] = record.fieldSources[key]; }
          else if (!existing.fieldSources[key]?.endsWith(':hidden') && existing[key] === null && record[key] !== null) { existing[key] = record[key]; existing.fieldSources[key] = record.fieldSources[key]; }
        }
      } else if (expectedShortcode) {
        throw fail('AUTHOR_MISMATCH', 'The discovered Instagram video does not confirm the requested owner.');
      }
    }
    for (const [key, node] of Object.entries(value)) {
      if (/cookie|session|token|password|secret|authorization/i.test(key)) continue;
      walk(node, `${path}.${key}`, depth + 1);
    }
  };
  for (const root of roots) walk(root.value, root.path);
  return [...records.values()].slice(0, limitPerId);
}

export function extractInstagramVideos(scriptTexts, options) { return extractInstagramRecords(scriptTexts, options, 6); }

export function extractInstagramListVideos(scriptTexts, options) { return extractInstagramRecords(scriptTexts, options, 100); }

export function instagramResponseError(response, stage) {
  const status = response?.status();
  if (response && status < 400) return null;
  const code = [403, 429].includes(status) ? `BLOCKED_HTTP_${status}` : 'HTTP_ERROR';
  const path = typeof response?.url === 'function' ? new URL(response.url()).pathname : null;
  const headers = typeof response?.headers === 'function' ? response.headers() : {};
  const retryAfter = headers['retry-after'] ?? null;
  return Object.assign(fail(code, `Instagram ${stage} unavailable (HTTP ${status ?? 'unknown'}); no retry.`), { stage, path, httpStatus: status ?? null, retryAfter, http: { status: status ?? null, stage, path, retryAfter } });
}

export function instagramPageBarrier(url) {
  const path = new URL(url).pathname;
  if (/\/(?:accounts\/login|login|signup)(?:\/|$)/.test(path)) return 'LOGIN_REQUIRED';
  if (/\/(?:challenge|checkpoint)(?:\/|$)/.test(path)) return 'CHALLENGE_REQUIRED';
  return null;
}

function profileSpec(value, limitPerId) {
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_URL', 'Use a public Instagram profile HTTPS URL.'); }
  const match = /^\/([a-zA-Z0-9._]+)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname) || url.port || url.username || url.password || !match || ['accounts', 'explore', 'reels', 'p', 'reel', 'direct'].includes(match[1].toLowerCase())) {
    throw fail('INVALID_URL', 'Use a public Instagram profile HTTPS URL.');
  }
  if (!Number.isSafeInteger(limitPerId) || limitPerId < 1 || limitPerId > 6) throw fail('INVALID_LIMIT', 'Instagram anonymous profile embeds support a bounded selection of 1–6 videos.');
  return { username: match[1], url: `https://www.instagram.com/${match[1]}/`, embedUrl: `https://www.instagram.com/${match[1]}/embed/?cr=1`, limitPerId };
}

export async function readInstagramEmbed(page, url, { stage = 'embed-detail', timeout = 30000 } = {}) {
  let response;
  try { response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout }); }
  catch (error) {
    if (error.name === 'TimeoutError') error.code = 'NAVIGATION_TIMEOUT';
    const path = new URL(url).pathname;
    throw Object.assign(error, { stage, path, httpStatus: null, retryAfter: null, http: { status: null, stage, path, retryAfter: null } });
  }
  const status = response?.status();
  const error = instagramResponseError(response, stage);
  if (error) throw error;
  const current = new URL(page.url());
  if (!['instagram.com', 'www.instagram.com'].includes(current.hostname)) throw fail('UNEXPECTED_REDIRECT', 'Instagram redirected outside its public website.');
  const barrier = instagramPageBarrier(current.href);
  if (barrier) throw Object.assign(fail(barrier, 'Instagram requires login or verification; anonymous collection stopped.'), { stage, path: current.pathname, httpStatus: status, retryAfter: null });
  const blocked = await page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    return { challenge: [...document.querySelectorAll('iframe[src*="captcha"], [id*="captcha"]')].some(node => node.getClientRects().length > 0) || /(?:confirm|verify) (?:that )?you(?:'re| are) human|请完成安全验证/i.test(text), login: /log in to (?:continue|view)|sign in to (?:continue|view)|登录后(?:查看|继续)|请先登录/i.test(text) };
  });
  if (blocked.challenge) throw Object.assign(fail('CHALLENGE_REQUIRED', 'Instagram requires verification; anonymous collection stopped.'), { stage, path: current.pathname, httpStatus: status, retryAfter: null });
  if (blocked.login) throw Object.assign(fail('LOGIN_REQUIRED', 'Instagram requires login; anonymous collection stopped.'), { stage, path: current.pathname, httpStatus: status, retryAfter: null });
  // Main-document response retains the literal scripts even if page hydration removes them.
  return { status, scripts: instagramScriptTexts(await response.text()) };
}

export async function collectInstagramHomepage(browser, options) {
  const spec = profileSpec(options.url, options.limitPerId);
  const records = [];
  const source = { url: spec.url, embedUrl: spec.embedUrl, requestedCount: spec.limitPerId, actualCount: 0, discoveredCount: 0, status: 'blocked', loginUsed: false, coverage: 'selected profile videos with platform-reported video views/likes; full history and pagination unsupported', evidence: { discovery: 'official-public-profile-embed-server-json', detail: 'official-public-video-embed-server-json', parserEvaluatedScripts: false, viewCountMeaning: 'view_count/video_view_count; kept separate from play_count/video_play_count' } };
  let context;
  let networkBlock;
  try {
    context = await browser.newContext({ javaScriptEnabled: true });
    const page = await context.newPage();
    page.on('response', response => {
      const url = new URL(response.url());
      if (['instagram.com', 'www.instagram.com'].includes(url.hostname) && [403, 429].includes(response.status())) networkBlock ??= instagramResponseError(response, url.pathname.includes('/p/') ? 'embed-detail' : 'embed-discovery');
    });
    const profile = await readInstagramEmbed(page, spec.embedUrl, { stage: 'embed-discovery' });
    if (networkBlock) throw networkBlock;
    source.httpStatus = profile.status;
    const discovered = extractInstagramVideos(profile.scripts, { expectedUsername: spec.username, limitPerId: spec.limitPerId });
    source.discoveredCount = discovered.length;
    if (!discovered.length) throw fail('NO_PUBLIC_VIDEOS', 'The public profile embed exposes no confirmed videos for the requested owner.');
    for (const record of discovered) {
      if (networkBlock) throw networkBlock;
      const detailUrl = `https://www.instagram.com/p/${record.id}/embed/?cr=1`;
      const detail = await readInstagramEmbed(page, detailUrl);
      if (networkBlock) throw networkBlock;
      const videos = extractInstagramVideos(detail.scripts, { expectedUsername: spec.username, expectedShortcode: record.id, limitPerId: 1 });
      if (videos.length !== 1 || videos[0].id !== record.id) throw fail('SHORTCODE_MISMATCH', 'The detail embed does not confirm the discovered video shortcode.');
      const combined = { ...record, fieldSources: Object.fromEntries(Object.entries(record.fieldSources).map(([key, path]) => [key, path && `profileEmbed.${path}`])) };
      const current = videos[0];
      for (const key of ['playCount', 'viewCount', 'likeCount', 'commentCount']) {
        if (combined.fieldSources[key]?.endsWith(':hidden')) continue;
        if (current[key] !== null || current.fieldSources[key]?.endsWith(':hidden')) {
          combined[key] = current[key]; combined.fieldSources[key] = `detailEmbed.${current.fieldSources[key]}`;
        }
      }
      combined.caption = current.caption ?? record.caption;
      records.push({ ...combined, sourceUrl: spec.url, detailEmbedUrl: detailUrl, metricPrecision: 'platform-reported; original counter precision not guaranteed', collectedAt: new Date().toISOString() });
    }
    const missingMetrics = records.some(record => (record.playCount === null && record.viewCount === null) || record.likeCount === null);
    source.status = records.length === spec.limitPerId && !missingMetrics ? 'completed' : 'partial';
    source.termination = missingMetrics ? 'required-metrics-unavailable' : records.length === spec.limitPerId ? 'requested-limit' : 'profile-selection-exhausted';
  } catch (error) {
    error = networkBlock ?? error;
    source.status = records.length ? 'partial' : 'blocked';
    source.termination = error.code ?? 'COLLECTION_FAILED'; source.error = error.message;
    source.diagnostics = { stage: error.stage ?? null, path: error.path ?? null, httpStatus: error.httpStatus ?? null, retryAfter: error.retryAfter ?? null };
    source.http = error.http ?? { status: source.diagnostics.httpStatus, stage: source.diagnostics.stage, path: source.diagnostics.path, retryAfter: source.diagnostics.retryAfter };
  } finally {
    if (context) await context.close();
    source.actualCount = records.length;
    source.playCountAvailable = records.filter(record => record.playCount !== null).length;
    source.viewCountAvailable = records.filter(record => record.viewCount !== null).length;
    source.collectedAt = new Date().toISOString();
  }
  return { records, source };
}

export async function readInstagramVideoDetail(page, { shortcode, expectedUsername, timeout }) {
  if (typeof shortcode !== 'string' || !/^[A-Za-z0-9_-]+$/.test(shortcode)) throw fail('INVALID_SHORTCODE', 'Use the exact discovered shortcode.');
  const url = `https://www.instagram.com/p/${shortcode}/embed/?cr=1`;
  const detail = await readInstagramEmbed(page, url, { stage: 'video-detail', timeout });
  if (instagramTimelineEvidence(detail.scripts, expectedUsername).privateProfile) throw Object.assign(fail('PRIVATE_PROFILE', 'The requested Instagram profile is private.'), { stage: 'video-detail', path: new URL(url).pathname, httpStatus: detail.status, retryAfter: null });
  let records;
  try { records = extractInstagramListVideos(detail.scripts, { expectedUsername, expectedShortcode: shortcode, limitPerId: 1 }); }
  catch (error) { throw Object.assign(error, { stage: 'video-detail', path: new URL(url).pathname, httpStatus: detail.status, retryAfter: null }); }
  if (records.length !== 1) throw Object.assign(fail('SHORTCODE_MISMATCH', 'The detail does not confirm the discovered video.'), { stage: 'video-detail', path: new URL(url).pathname, httpStatus: detail.status, retryAfter: null });
  return records[0];
}

// Project only ownership and public list-completeness evidence, never the decoded page state.
export function instagramTimelineEvidence(scriptTexts, expectedUsername) {
  const completeLists = [], pagination = [];
  let privateProfile = false;
  const matches = value => typeof value === 'string' && value.toLowerCase() === expectedUsername.toLowerCase();
  let visited = 0;
  const walk = (value, path, depth = 0) => {
    if (++visited > 150000 || depth > 80) throw fail('PAGE_DATA_TOO_LARGE', 'Instagram timeline data exceeds the bounded parser limit.');
    if (typeof value === 'string' && /^\s*[\[{]/.test(value)) {
      let decoded; try { decoded = JSON.parse(value); } catch { return; }
      walk(decoded, path + '.decoded-json-string', depth + 1); return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((node, index) => walk(node, `${path}[${index}]`, depth + 1)); return; }
    if (matches(value.username) && value.is_private === true
      || matches((value.owner ?? value.user)?.username) && (value.is_private === true || (value.owner ?? value.user)?.is_private === true)) privateProfile = true;
    const timeline = value.edge_owner_to_timeline_media;
    if (matches(value.username) && Array.isArray(timeline?.edges)) {
      const nodes = timeline.edges.map(edge => edge?.node);
      const valid = nodes.every(node => node && typeof (node.shortcode ?? node.code) === 'string'
        && matches(node.owner?.username)
        && node.is_private !== true && node.owner?.is_private !== true && node.is_recommendation !== true && node.is_recommended !== true
        && (['GraphImage', 'GraphVideo', 'GraphSidecar'].includes(node.__typename) || [1, 2, 8].includes(node.media_type)));
      const unique = new Set(nodes.map(node => node?.shortcode ?? node?.code)).size;
      if (valid && unique === nodes.length && timeline.page_info?.has_next_page === false
        && Number.isSafeInteger(timeline.count) && timeline.count === nodes.length) {
        completeLists.push({ path: `${path}.edge_owner_to_timeline_media`, count: timeline.count, shortcodes: nodes.map(node => node.shortcode ?? node.code), videoShortcodes: nodes.filter(node => node.__typename === 'GraphVideo' || node.is_video === true || node.media_type === 2).map(node => node.shortcode ?? node.code) });
      }
    }
    for (const [key, node] of Object.entries(value)) {
      if (['has_next_page', 'end_cursor', 'next_cursor', 'more_available'].includes(key) && pagination.length < 50 && (node === null || ['string', 'boolean'].includes(typeof node))) pagination.push({ path: `${path}.${key}`, value: node });
      if (!/cookie|session|token|password|secret|authorization/i.test(key)) walk(node, `${path}.${key}`, depth + 1);
    }
  };
  for (const root of instagramJsonRoots(scriptTexts)) walk(root.value, root.path);
  return { completeLists, pagination, privateProfile };
}

export function extractInstagramVideoAuthor(scriptTexts, shortcode) {
  if (typeof shortcode !== 'string' || !/^[A-Za-z0-9_-]+$/.test(shortcode)) throw fail('INVALID_SHORTCODE', 'Use the exact supplied shortcode.');
  const owners = new Set();
  let visited = 0;
  const walk = (value, depth = 0) => {
    if (++visited > 150000 || depth > 80) throw fail('PAGE_DATA_TOO_LARGE', 'Instagram data exceeds the bounded parser limit.');
    if (typeof value === 'string' && /^\s*[\[{]/.test(value)) { let node; try { node = JSON.parse(value); } catch { return; } walk(node, depth + 1); return; }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(node => walk(node, depth + 1)); return; }
    const owner = value.owner ?? value.user;
    if ((value.shortcode ?? value.code) === shortcode && (value.is_private === true || owner?.is_private === true)) throw fail('PRIVATE_PROFILE', 'The video owner is private.');
    if ((value.shortcode ?? value.code) === shortcode && (value.__typename === 'GraphVideo' || value.is_video === true || value.media_type === 2)
      && typeof owner?.username === 'string' && /^[A-Za-z0-9._]{1,30}$/.test(owner.username)) owners.add(owner.username);
    for (const [key, node] of Object.entries(value)) if (!/cookie|session|token|password|secret|authorization/i.test(key)) walk(node, depth + 1);
  };
  for (const root of instagramJsonRoots(scriptTexts)) walk(root.value);
  if (new Set([...owners].map(value => value.toLowerCase())).size !== 1) throw fail('AUTHOR_UNCONFIRMED', 'The exact video shortcode does not establish one public author.');
  return [...owners][0];
}
