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

// Parse JSON and literal ServerJS arguments only. Never evaluate the script wrapper.
export function extractInstagramVideos(scriptTexts, { expectedUsername, limitPerId, expectedShortcode }) {
  if (typeof expectedUsername !== 'string' || !/^[a-zA-Z0-9._]+$/.test(expectedUsername)) throw fail('INVALID_USERNAME', 'A public Instagram username is required.');
  if (!Number.isSafeInteger(limitPerId) || limitPerId < 1 || limitPerId > 6) throw fail('INVALID_LIMIT', 'Instagram profile embed collection is limited to a selection of 1–6 videos.');
  if (expectedShortcode !== undefined && (typeof expectedShortcode !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(expectedShortcode))) throw fail('INVALID_SHORTCODE', 'Use the exact discovered Instagram shortcode.');
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
    const video = value.__typename === 'GraphVideo' || value.is_video === true || value.media_type === 2;
    if (typeof code === 'string' && /^[a-zA-Z0-9_-]+$/.test(code) && video && (!expectedShortcode || code === expectedShortcode)) {
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
        const record = {
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
        else for (const key of ['playCount', 'viewCount', 'likeCount', 'commentCount']) {
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

async function readEmbed(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const status = response?.status();
  if ([403, 429].includes(status)) throw fail(`BLOCKED_HTTP_${status}`, `Instagram returned HTTP ${status}; anonymous collection stopped without retry.`);
  if (!response || status >= 400) throw fail('HTTP_ERROR', `Instagram public embed unavailable (HTTP ${status ?? 'unknown'}).`);
  const current = new URL(page.url());
  if (!['instagram.com', 'www.instagram.com'].includes(current.hostname)) throw fail('UNEXPECTED_REDIRECT', 'Instagram redirected outside its public website.');
  if (/\/(?:accounts\/login|login|signup)(?:\/|$)/.test(current.pathname)) throw fail('LOGIN_REQUIRED', 'Instagram requires login; anonymous collection stopped.');
  if (/\/(?:challenge|checkpoint)(?:\/|$)/.test(current.pathname)) throw fail('CHALLENGE_REQUIRED', 'Instagram requires verification; anonymous collection stopped.');
  const blocked = await page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    return { challenge: [...document.querySelectorAll('iframe[src*="captcha"], [id*="captcha"]')].some(node => node.getClientRects().length > 0) || /(?:confirm|verify) (?:that )?you(?:'re| are) human|请完成安全验证/i.test(text), login: /log in to (?:continue|view)|sign in to (?:continue|view)|登录后(?:查看|继续)|请先登录/i.test(text) };
  });
  if (blocked.challenge) throw fail('CHALLENGE_REQUIRED', 'Instagram requires verification; anonymous collection stopped.');
  if (blocked.login) throw fail('LOGIN_REQUIRED', 'Instagram requires login; anonymous collection stopped.');
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
      if (['instagram.com', 'www.instagram.com'].includes(url.hostname) && [403, 429].includes(response.status())) networkBlock ??= fail(`BLOCKED_HTTP_${response.status()}`, `Instagram request ${url.pathname} returned HTTP ${response.status()}; stopped without retry.`);
    });
    const profile = await readEmbed(page, spec.embedUrl);
    if (networkBlock) throw networkBlock;
    source.httpStatus = profile.status;
    const discovered = extractInstagramVideos(profile.scripts, { expectedUsername: spec.username, limitPerId: spec.limitPerId });
    source.discoveredCount = discovered.length;
    if (!discovered.length) throw fail('NO_PUBLIC_VIDEOS', 'The public profile embed exposes no confirmed videos for the requested owner.');
    for (const record of discovered) {
      if (networkBlock) throw networkBlock;
      const detailUrl = `https://www.instagram.com/p/${record.id}/embed/?cr=1`;
      const detail = await readEmbed(page, detailUrl);
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
  } finally {
    if (context) await context.close();
    source.actualCount = records.length;
    source.playCountAvailable = records.filter(record => record.playCount !== null).length;
    source.viewCountAvailable = records.filter(record => record.viewCount !== null).length;
    source.collectedAt = new Date().toISOString();
  }
  return { records, source };
}
