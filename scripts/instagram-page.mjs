function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

export function parseInstagramUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('invalid-url', 'An Instagram HTTPS URL is required.'); }
  if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw failure('invalid-url', 'An Instagram HTTPS URL is required.');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 2 && ['p', 'reel'].includes(parts[0]) && /^[A-Za-z0-9_-]+$/.test(parts[1])) {
    return { kind: 'post', shortcode: parts[1], url: `https://www.instagram.com/${parts[0]}/${parts[1]}/` };
  }
  if (parts.length === 1 && /^[A-Za-z0-9._]{1,30}$/.test(parts[0]) && !['accounts', 'explore', 'direct', 'stories', 'reels', 'challenge', 'about', 'developer', 'legal', 'privacy', 'terms', 'web', 'api'].includes(parts[0].toLowerCase())) {
    return { kind: 'profile', username: parts[0], url: `https://www.instagram.com/${parts[0]}/` };
  }
  throw failure('unsupported-url', 'Use an Instagram profile, /p/, or /reel/ URL.');
}

function sameTarget(left, right) {
  return left.kind === right.kind && (left.kind === 'post' ? left.shortcode === right.shortcode : left.username.toLowerCase() === right.username.toLowerCase());
}

// Self-contained and intentionally limited to rendered DOM, OG metadata and JSON-LD.
// It can also run against local synthetic HTML through page.evaluate in offline tests.
export function collectInstagramSnapshot(request) {
  const clean = value => typeof value === 'string' ? value.trim() || null : null;
  const shown = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const text = element => shown(element) ? clean(element.innerText ?? element.textContent) : null;
  const canonicalize = value => {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const u = new URL(value, location.href);
      if (u.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(u.hostname) || u.username || u.password || u.port) return null;
      return `https://www.instagram.com${u.pathname.replace(/\/+$/, '')}/`;
    } catch { return null; }
  };
  const expected = canonicalize(request.url);
  const same = value => {
    const candidate = canonicalize(value);
    const shortcode = value => value?.match(/^https:\/\/www\.instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)\/$/)?.[1];
    return shortcode(expected) ? shortcode(candidate) === shortcode(expected) : candidate?.toLowerCase() === expected?.toLowerCase();
  };
  const meta = name => clean(document.querySelector(`meta[property="${name}"]`)?.content);
  const body = document.body?.innerText ?? '';
  const path = location.pathname;
  if (/\/challenge(?:\/|$)|\/checkpoint(?:\/|$)/.test(path) || [...document.querySelectorAll('iframe[src*="captcha"], [data-testid*="captcha"]')].some(shown) || /confirm you(?:'re| are) human|verify (?:that )?you(?:'re| are) human|security check|确认你是真人/i.test(body)) return { error: 'challenge-required' };
  if (/\/accounts\/login(?:\/|$)/.test(path) || /log in to (?:see|continue|view)|登录后(?:查看|继续)/i.test(body)) return { error: 'login-required' };
  if (/sorry, this page isn't available|page (?:isn't|is not) available|此页面无法访问|页面不存在/i.test(body)) return { error: 'not-found' };
  const canonical = document.querySelector('link[rel="canonical"]')?.href;
  const ogUrl = meta('og:url');
  if ([canonical, ogUrl].filter(Boolean).some(value => !same(value))) return { error: 'canonical-mismatch' };
  // Do not return or traverse hydration scripts, cookies, application state or arbitrary script strings.
  const entities = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const root = JSON.parse(script.textContent);
      const nodes = Array.isArray(root) ? root : [root];
      for (const node of nodes) {
        if (node && typeof node === 'object') entities.push(node, ...(Array.isArray(node['@graph']) ? node['@graph'] : []));
      }
    } catch { /* A malformed optional JSON-LD block is not executable code. */ }
  }
  const types = node => [node?.['@type']].flat().filter(value => typeof value === 'string');
  const matches = node => [node?.url, node?.mainEntityOfPage, node?.['@id']].some(value => same(typeof value === 'object' ? value?.['@id'] : value));
  const entity = entities.find(node => matches(node) && types(node).some(type => request.task === 'profile' ? ['Person', 'ProfilePage'].includes(type) : ['SocialMediaPosting', 'ImageObject', 'VideoObject', 'Article'].includes(type)));
  const json = {};
  if (entity) {
    // These are public schema.org fields only, copied one by one.
    for (const key of ['name', 'description', 'caption', 'articleBody', 'datePublished', 'uploadDate', 'contentUrl', 'thumbnailUrl']) {
      if (typeof entity[key] === 'string') json[key] = entity[key];
    }
    const image = entity.image;
    json.image = typeof image === 'string' ? image : typeof image?.url === 'string' ? image.url : null;
    const author = entity.author;
    if (author && typeof author === 'object' && !Array.isArray(author)) json.author = { name: clean(author.name), url: clean(author.url) };
    if (Array.isArray(entity.interactionStatistic)) {
      json.interactions = entity.interactionStatistic.map(item => ({
        type: typeof item?.interactionType === 'string' ? item.interactionType : item?.interactionType?.['@type'],
        count: typeof item?.userInteractionCount === 'number' || typeof item?.userInteractionCount === 'string' ? item.userInteractionCount : null,
      }));
    }
  }
  const links = [...new Set([...document.querySelectorAll('a[href]')].map(a => canonicalize(a.href)).filter(value => value && /^https:\/\/www\.instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+\/$/.test(value)))];
  const articles = [...document.querySelectorAll('article')].filter(shown);
  const targetArticles = request.task === 'profile' ? [] : articles.filter(item =>
    [item.getAttribute('data-instagram-permalink'), ...[...item.querySelectorAll('a[href]')].map(a => a.href)].some(value => value && same(value))
  );
  // A recommendation before the target must never supply the target record's fields.
  // With multiple articles, use a unique target permalink or only matched JSON-LD.
  const singleArticleOnTargetPage = articles.length === 1 && [canonical, ogUrl, location.href].some(value => value && same(value));
  const article = request.task === 'profile' ? null : targetArticles.length === 1 ? targetArticles[0] : singleArticleOnTargetPage ? articles[0] : null;
  const articleAttribution = targetArticles.length === 1 ? 'target-permalink' : article ? 'single-article-on-target-page' : null;
  const header = request.task === 'profile' ? document.querySelector('main header') : article?.querySelector('header');
  const profileLink = root => [...(root?.querySelectorAll('a[href]') ?? [])].find(a => {
    const value = canonicalize(a.href);
    return value && /^https:\/\/www\.instagram\.com\/[A-Za-z0-9._]{1,30}\/$/.test(value) && !/\/(?:explore|accounts|direct|reels)\/$/.test(value) && text(a);
  });
  const authorLink = profileLink(header);
  const title = text(article?.querySelector('h1'));
  const heading = text(header?.querySelector('h1, h2'));
  const expectedUsername = request.task === 'profile' ? new URL(request.url).pathname.split('/').filter(Boolean)[0] : null;
  const profileUsername = expectedUsername && [...(header?.querySelectorAll('h1, h2') ?? [])].map(text).find(value => value?.replace(/^@/, '').toLowerCase() === expectedUsername.toLowerCase()) ? expectedUsername : null;
  const profileCounters = {};
  if (request.task === 'profile' && header) {
    for (const link of header.querySelectorAll('a[href]')) {
      const href = canonicalize(link.href);
      for (const [field, suffix] of [['followerCount', 'followers/'], ['followingCount', 'following/']]) {
        if (href?.toLowerCase() !== `${expected}${suffix}`.toLowerCase()) continue;
        const span = [...link.querySelectorAll('span')].find(shown);
        profileCounters[field] = clean(span?.getAttribute('title')) ?? text(span);
      }
    }
  }
  const comments = [];
  if (request.task === 'comment' && article) {
    const candidates = article.querySelectorAll('[data-testid="comment"], [data-comment-id], [aria-label="Comments"] li, [aria-label="评论"] li, [data-testid="comments"] li');
    for (const item of candidates) {
      if (!shown(item) || item.querySelector('h1') || item.closest('header')) continue;
      // Nested list containers are not comments. Require an author, body and timestamp.
      if (item.querySelector('li')) continue;
      const author = profileLink(item);
      const time = item.querySelector('time[datetime]');
      const content = [...item.querySelectorAll('[data-testid="comment-text"], span[dir="auto"]')].find(span => !author?.contains(span) && !span.closest('a, button, time') && text(span));
      const commentText = text(content);
      if (!author || !time || !commentText || commentText === title) continue;
      comments.push({ authorUrl: author.href, authorName: text(author), text: commentText, publishedAt: time.dateTime });
    }
  }
  return {
    canonical: canonical ? canonicalize(canonical) : null,
    og: { title: meta('og:title'), description: meta('og:description'), image: meta('og:image'), video: meta('og:video') },
    heading, profileUsername, hasArticle: Boolean(article), articleAttribution, caption: title, author: authorLink ? { name: text(authorLink), url: authorLink.href } : null,
    publishedAt: article?.querySelector('time[datetime]')?.dateTime ?? null,
    images: article ? [...article.querySelectorAll('img')].filter(shown).filter(img => !img.closest('header')).map(img => ({ url: img.currentSrc || img.src, alt: clean(img.alt) })) : [],
    video: article?.querySelector('video')?.currentSrc || article?.querySelector('video')?.src || null,
    displayText: request.task === 'profile' ? text(header) : null,
    json, hasMatchedJson: Boolean(entity), profileCounters, comments, links,
  };
}

function safeMedia(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    for (const key of [...url.searchParams.keys()]) if (/token|session|cookie|password|secret|authorization/i.test(key)) url.searchParams.delete(key);
    url.hash = '';
    return url.href;
  } catch { return null; }
}
const clean = value => typeof value === 'string' ? value.trim() || null : null;
const exactCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value
  : typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const displayedCount = value => typeof value === 'string' && /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value) ? exactCount(value.replaceAll(',', '')) : null;
const timestamp = value => clean(value) && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;

export function normalizeInstagramSnapshot(snapshot, request) {
  const target = parseInstagramUrl(request.url);
  if (!['profile', 'post', 'comment'].includes(request.task) || (request.task === 'profile') !== (target.kind === 'profile')) throw failure('unsupported-task', 'The Instagram task must match the URL type.');
  if (snapshot?.error) throw failure(snapshot.error, `Instagram page unavailable: ${snapshot.error}.`);
  if (!snapshot || typeof snapshot !== 'object') throw failure('no-public-record', 'No public Instagram page record was found.');
  if (snapshot.canonical && !sameTarget(parseInstagramUrl(snapshot.canonical), target)) throw failure('canonical-mismatch', 'The page does not match the requested Instagram URL.');
  const fieldSources = {};
  const take = (field, options) => {
    const match = options.find(([, value]) => value !== null && value !== undefined && value !== '');
    fieldSources[field] = match?.[0] ?? null;
    return match?.[1] ?? null;
  };
  const json = snapshot.json ?? {};
  const og = snapshot.og ?? {};
  const author = value => {
    try { const parsed = parseInstagramUrl(value?.url); return parsed.kind === 'profile' ? { username: parsed.username, displayName: clean(value.name), url: parsed.url } : null; } catch { return null; }
  };
  const links = [...new Set((snapshot.links ?? []).flatMap(value => { try { const parsed = parseInstagramUrl(value); return parsed.kind === 'post' ? [parsed.url] : []; } catch { return []; } }))];
  let records;
  if (request.task === 'profile') {
    const ogMatches = new RegExp(`@${target.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^A-Za-z0-9._])`, 'i').test(og.title ?? '');
    const headingMatches = [snapshot.profileUsername, snapshot.heading].some(value => clean(value)?.replace(/^@/, '').toLowerCase() === target.username.toLowerCase());
    if (!snapshot.hasMatchedJson && !headingMatches && !ogMatches) throw failure('no-public-record', 'No matching public Instagram profile was found.');
    records = [{ platform: 'instagram', type: 'profile', id: null, idType: null, username: target.username, url: target.url,
      displayName: take('displayName', [['json-ld.name', clean(json.name)]]),
      headingText: clean(snapshot.heading), ogTitleText: clean(og.title),
      bio: take('bio', [['json-ld.description', clean(json.description)]]),
      avatarUrl: take('avatarUrl', [['json-ld.image', safeMedia(json.image)], ['og:image', safeMedia(og.image)]]),
      followerCount: take('followerCount', [['header.followers-link', displayedCount(snapshot.profileCounters?.followerCount)]]),
      followingCount: take('followingCount', [['header.following-link', displayedCount(snapshot.profileCounters?.followingCount)]]), postCount: null,
      displayText: clean(snapshot.displayText), descriptionText: clean(og.description), fieldSources,
    }];
  } else if (request.task === 'post') {
    const caption = take('caption', [['article.h1', clean(snapshot.caption)], ['json-ld.articleBody', clean(json.articleBody)], ['json-ld.caption', clean(json.caption)], ['json-ld.description', clean(json.description)]]);
    const images = (snapshot.images ?? []).map(item => ({ url: safeMedia(item.url), alt: clean(item.alt) })).filter(item => item.url);
    if (!images.length) {
      const url = take('images', [['json-ld.image', safeMedia(json.image)], ['og:image', safeMedia(og.image)]]);
      if (url) images.push({ url, alt: null });
    } else fieldSources.images = 'article.img';
    const videoUrl = take('videoUrl', [['article.video', safeMedia(snapshot.video)], ['json-ld.contentUrl', safeMedia(json.contentUrl)], ['og:video', safeMedia(og.video)]]);
    if (!snapshot.hasMatchedJson && !caption && !(snapshot.hasArticle && (images.length || videoUrl))) throw failure('no-public-record', 'No public Instagram post was found.');
    const interactions = Array.isArray(json.interactions) ? json.interactions : [];
    const counter = (field, type) => take(field, [['json-ld.interactionStatistic', exactCount(interactions.find(item => new RegExp(`(?:^|[/#])${type}$`).test(item.type ?? ''))?.count)]]);
    records = [{ platform: 'instagram', type: 'post', id: target.shortcode, idType: 'shortcode', shortcode: target.shortcode, url: target.url,
      caption, author: take('author', [['article.header', author(snapshot.author)], ['json-ld.author', author(json.author)]]),
      publishedAt: take('publishedAt', [['article.time', timestamp(snapshot.publishedAt)], ['json-ld.datePublished', timestamp(json.datePublished ?? json.uploadDate)]]),
      images, videoUrl, likeCount: counter('likeCount', 'LikeAction'), commentCount: counter('commentCount', 'CommentAction'), viewCount: counter('viewCount', 'WatchAction'),
      descriptionText: clean(og.description), fieldSources,
    }];
  } else {
    const comments = (snapshot.comments ?? []).map(item => ({
      platform: 'instagram', type: 'comment', id: null, idType: null, postShortcode: target.shortcode, url: target.url,
      author: author({ url: item.authorUrl, name: item.authorName }), text: clean(item.text), publishedAt: timestamp(item.publishedAt),
      likeCount: null, fieldSources: { author: 'article.comment.author-link', text: 'article.comment.body', publishedAt: 'article.comment.time' },
    })).filter(item => item.author && item.text && item.publishedAt);
    const unique = new Map();
    for (const comment of comments) {
      const key = JSON.stringify([comment.author.username.toLowerCase(), comment.publishedAt, comment.text]);
      if (!unique.has(key)) unique.set(key, comment);
    }
    records = [...unique.values()].slice(0, request.limitPerId ?? 20);
    if (!records.length) throw failure('no-public-record', 'No explicit public Instagram comment structure was found.');
  }
  return { records, links, evidence: { source: 'public-page-dom-and-metadata', url: target.url, task: request.task, recordCount: records.length, liveVerified: false } };
}

export async function readInstagramPage(page, options) {
  const request = { ...options, limitPerId: options.limitPerId ?? 20 };
  const target = parseInstagramUrl(request.url);
  if (!['profile', 'post', 'comment'].includes(request.task) || (request.task === 'profile') !== (target.kind === 'profile')) throw failure('unsupported-task', 'The Instagram task must match the URL type.');
  if (!Number.isSafeInteger(request.limitPerId) || request.limitPerId < 1) throw failure('invalid-limit', 'limitPerId must be a positive integer.');
  const current = new URL(page.url());
  if (current.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(current.hostname)) throw failure('unsupported-page', 'Open the requested Instagram page first.');
  if (!/\/(?:accounts\/login|challenge|checkpoint)(?:\/|$)/.test(current.pathname)) {
    let currentTarget;
    try { currentTarget = parseInstagramUrl(current.href); } catch { throw failure('canonical-mismatch', 'The current Instagram page does not match the requested URL.'); }
    if (!sameTarget(currentTarget, target)) throw failure('canonical-mismatch', 'The current Instagram page does not match the requested URL.');
  }
  const snapshot = await page.evaluate(collectInstagramSnapshot, request);
  return normalizeInstagramSnapshot(snapshot, request);
}
