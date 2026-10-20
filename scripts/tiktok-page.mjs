function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

const text = value => typeof value === 'string' ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const flag = value => typeof value === 'boolean' ? value : null;

function publicAvatar(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/token|session|cookie|password|secret|authorization/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.href;
  } catch { return null; }
}

// Only the observed public userInfo shape is accepted. Missing counters stay unknown.
export function normalizeTikTokProfile(userInfo, expectedUsername) {
  if (typeof expectedUsername !== 'string' || !expectedUsername.trim()) {
    throw failure('INVALID_USERNAME', 'A TikTok username is required.');
  }
  const expected = expectedUsername.trim().replace(/^@/, '');
  const user = userInfo?.user;
  if (!user || typeof user !== 'object' || Array.isArray(user) || typeof user.uniqueId !== 'string' || !user.uniqueId) {
    throw failure('PROFILE_DATA_MISSING', 'TikTok public profile data is missing.');
  }
  if (user.uniqueId.toLowerCase() !== expected.toLowerCase()) {
    throw failure('USERNAME_MISMATCH', 'The TikTok page profile does not match the requested username.');
  }
  const id = typeof user.id === 'string' && /^\d+$/.test(user.id) ? user.id
    : Number.isSafeInteger(user.id) && user.id >= 0 ? String(user.id) : null;
  if (!id) throw failure('INVALID_PROFILE_ID', 'TikTok profile ID is missing or cannot be represented without precision loss.');
  const stats = userInfo.stats ?? {};
  return {
    platform: 'tiktok', type: 'profile', id, username: user.uniqueId,
    displayName: text(user.nickname), bio: text(user.signature),
    verified: flag(user.verified), privateAccount: flag(user.privateAccount),
    followerCount: count(stats.followerCount), followingCount: count(stats.followingCount),
    likeCount: count(stats.heartCount ?? stats.heart), postCount: count(stats.videoCount),
    url: `https://www.tiktok.com/@${encodeURIComponent(user.uniqueId)}`,
    avatarUrl: publicAvatar(user.avatarLarger ?? user.avatarMedium ?? user.avatarThumb),
  };
}

export async function readTikTokProfile(page, expectedUsername) {
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || !['www.tiktok.com', 'tiktok.com'].includes(url.hostname)) {
    throw failure('UNSUPPORTED_PAGE', 'Open the requested public TikTok profile first.');
  }
  const observed = await page.evaluate(() => {
    const body = document.body?.innerText ?? '';
    const visible = element => Boolean(element && element.getClientRects().length);
    const challenge = [...document.querySelectorAll('[id*="captcha"], [class*="captcha"], iframe[src*="captcha"]')].some(visible)
      || /verify (?:that )?you(?:'re| are) human|complete (?:the )?(?:security )?verification|验证您是真人|请完成安全验证/i.test(body);
    if (challenge) return { challenge: true };
    const element = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    let userInfo;
    try {
      userInfo = JSON.parse(element?.textContent ?? '').__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo;
    } catch { /* An unavailable or changed page is not an empty profile. */ }
    if (!userInfo?.user) return { loginRequired: /log in to (?:continue|view)|sign in to (?:continue|view)|登录后(?:查看|继续)|请先登录/i.test(body) || /\/login(?:\/|$)/.test(location.pathname) };
    const u = userInfo.user;
    const s = userInfo.stats;
    // Do not return the page state or app context: they can contain session values.
    return { userInfo: {
      user: { id: u.id, uniqueId: u.uniqueId, nickname: u.nickname, signature: u.signature, verified: u.verified, privateAccount: u.privateAccount, avatarLarger: u.avatarLarger, avatarMedium: u.avatarMedium, avatarThumb: u.avatarThumb },
      stats: s && { followerCount: s.followerCount, followingCount: s.followingCount, heartCount: s.heartCount, heart: s.heart, videoCount: s.videoCount },
    } };
  });
  if (observed.challenge) throw failure('CHALLENGE_REQUIRED', 'TikTok requires a verification challenge; complete it in the browser before collecting.');
  if (observed.loginRequired) throw failure('LOGIN_REQUIRED', 'TikTok requires platform login to view this page.');
  const record = normalizeTikTokProfile(observed.userInfo, expectedUsername);
  return {
    records: [{ ...record, collectedAt: new Date().toISOString() }],
    evidence: { source: 'page-embedded-json', scriptId: '__UNIVERSAL_DATA_FOR_REHYDRATION__', scope: 'webapp.user-detail', url: record.url, recordCount: 1 },
  };
}
