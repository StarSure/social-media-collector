// Assess observed records; quantity or sorting alone never proves latest coverage.
export function publicationTime(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000) return value * 1000;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds <= 8640000000000 ? seconds * 1000 : null;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  return null;
}

export function knownCount(value) {
  return Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && /^\d+$/.test(value);
}

export function publicCounters(record) {
  const copy = { ...record };
  for (const field of ['playCount', 'viewCount', 'likeCount', 'commentCount', 'shareCount', 'collectCount']) {
    if ([record.fieldSources?.[field], record.metricSources?.[field]].some(source => typeof source === 'string' && source.endsWith(':hidden'))
      || record.like_and_view_counts_disabled === true && ['playCount', 'viewCount', 'likeCount'].includes(field)) copy[field] = null;
  }
  return copy;
}

export function recordBelongsToProfile(record, profileUrl, platform) {
  try {
    const profile = new URL(profileUrl), url = new URL(record?.url);
    const username = profile.pathname.replace(/^\/@?/, '').replace(/\/$/, '');
    const profilePattern = platform === 'tiktok' ? /^\/@[a-zA-Z0-9._]+\/?$/ : /^\/[a-zA-Z0-9._]+\/?$/;
    const hosts = [platform + '.com', 'www.' + platform + '.com'];
    const id = typeof record?.id === 'string' && (platform === 'tiktok' ? /^\d+$/ : /^[a-zA-Z0-9_-]+$/).test(record.id);
    const expected = platform === 'tiktok' ? `/@${record.username}/video/${record.id}` : `/p/${record.id}/`;
    return Boolean(id && record.platform === platform && record.type === 'video' && typeof record.username === 'string' && record.username.toLowerCase() === username.toLowerCase()
      && [profile, url].every(item => item.protocol === 'https:' && hosts.includes(item.hostname) && !item.port && !item.username && !item.password)
      && profilePattern.test(profile.pathname) && url.pathname.replace(/\/$/, '') === expected.replace(/\/$/, ''));
  } catch { return false; }
}

export function classifyFailure(source) {
  const code = source.termination ?? '';
  if (/429|RATE_LIMIT/.test(code)) return 'rate-limited';
  if (/LOGIN|401/.test(code)) return 'login-required';
  if (/CHALLENGE|CAPTCHA|VERIFICATION/.test(code)) return 'verification-required';
  if (/403|PRIVATE_PROFILE/.test(code)) return 'access-denied';
  if (/TIMEOUT/.test(code)) return 'network-timeout';
  if (/AUTHOR|IDENTITY|VIDEO_ID|SHORTCODE/.test(code)) return 'identity-mismatch';
  if (/metrics/.test(code)) return 'metrics-unavailable';
  if (/exhausted|no-new|NO_PUBLIC/.test(code)) return 'list-exhausted';
  if (/latest-order/.test(code)) return 'latest-order-unverified';
  return source.status === 'completed' ? null : source.status === 'skipped' ? 'not-visited' : 'collection-failed';
}

export function assessAccount(spec, source, input) {
  const selection = spec.selection ?? 'embed';
  const profile = new URL(source.url);
  if (profile.protocol !== 'https:' || ![spec.platform + '.com', 'www.' + spec.platform + '.com'].includes(profile.hostname) || profile.username || profile.password || profile.port) throw Object.assign(new Error('Invalid result profile URL.'), { code: 'INVALID_RESULT' });
  const unique = new Map();
  let rejectedCount = 0;
  let duplicateCount = 0;
  for (const value of input) {
    if (!recordBelongsToProfile(value, source.url, spec.platform)) { rejectedCount++; continue; }
    const record = publicCounters(value);
    if (unique.has(record.id)) { duplicateCount++; continue; }
    unique.set(record.id, record);
  }
  let records = [...unique.values()];
  const undatedCandidateCount = records.filter(record => publicationTime(record.publishedAt) === null).length;
  if (selection === 'latest') records.sort((a, b) => (publicationTime(b.publishedAt) ?? -1) - (publicationTime(a.publishedAt) ?? -1));
  records = records.slice(0, spec.limitPerId);
  const metricCompleteCount = records.filter(record => knownCount(record.likeCount) && (spec.platform === 'tiktok' ? knownCount(record.playCount) : knownCount(record.playCount) || knownCount(record.viewCount))).length;
  const missingPublicationTimeCount = records.filter(record => publicationTime(record.publishedAt) === null).length;
  const latestVerified = selection === 'latest' && source.latestVerified === true && !undatedCandidateCount && !rejectedCount;
  const quality = {
    requestedCount: spec.limitPerId, uniqueVideoCount: records.length,
    shortfall: Math.max(0, spec.limitPerId - records.length), metricCompleteCount,
    missingMetricCount: records.length - metricCompleteCount, missingPublicationTimeCount, undatedCandidateCount,
    rejectedCount, duplicateCount, latestVerified,
    meetsRequirements: source.status === 'completed' && records.length === spec.limitPerId && metricCompleteCount === records.length && !rejectedCount && (selection !== 'latest' || latestVerified),
  };
  const updated = { ...source, requestedCount: spec.limitPerId, actualCount: records.length, latestVerified, quality };
  if (source.status === 'completed' && !quality.meetsRequirements) {
    updated.status = records.length ? 'partial' : 'blocked';
    updated.termination = rejectedCount ? 'AUTHOR_OR_ID_MISMATCH' : quality.shortfall ? 'requested-count-unavailable' : metricCompleteCount !== records.length ? 'required-metrics-unavailable' : 'latest-order-unverified';
  }
  updated.errorCategory = classifyFailure(updated);
  return { records, source: updated };
}

export function accountSummary(spec, sources) {
  return spec.urls.map(url => {
    const source = sources.find(item => (item.originalUrl ?? item.url).toLowerCase() === url.toLowerCase());
    return source ? { url, resolvedUrl: source.url, status: source.status, termination: source.termination, errorCategory: source.errorCategory, ...source.quality, resumed: source.resumed === true, sourceRefs: source.sourceRefs ?? [] }
      : { url, status: 'skipped', errorCategory: 'not-visited', requestedCount: spec.limitPerId, uniqueVideoCount: 0, shortfall: spec.limitPerId, metricCompleteCount: 0, latestVerified: false, meetsRequirements: false, sourceRefs: spec.sourceRefs?.[url] ?? [] };
  });
}
