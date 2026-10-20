const shell = (url, content, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><link rel="canonical" href="${url}">${extra}</head><body><main>${content}</main></body></html>`;

const comment = content => `<li><a href="https://www.instagram.com/commenter/">Commenter</a><span dir="auto">${content}</span><time datetime="2026-01-01T00:00:00Z">January 1</time></li>`;

export const instagramBrowserFixtures = {
  profile: {
    request: { task: 'profile', url: 'https://www.instagram.com/sample.creator/', limitPerId: 2 },
    html: shell('https://www.instagram.com/sample.creator/', '<header><h2>Sample Creator</h2><p>1.2K followers · 24 posts</p></header><a href="https://www.instagram.com/p/Sample01/">Post</a><a href="https://www.instagram.com/reel/Sample02/">Reel</a><a href="https://example.com/p/NotOurs/">Other site</a>', '<meta property="og:title" content="Sample Creator (@sample.creator) • Instagram"><meta property="og:description" content="1.2K Followers, 12 Following, 24 Posts"><meta property="og:image" content="https://images.example/avatar.jpg">'),
    expectedCount: 1,
  },
  post: {
    request: { task: 'post', url: 'https://www.instagram.com/p/Sample01/', limitPerId: 2 },
    html: shell('https://www.instagram.com/p/Sample01/', '<article><header><a href="https://www.instagram.com/sample.creator/">Sample Creator</a><img src="https://images.example/avatar.jpg"></header><h1>Synthetic caption only.</h1><time datetime="2026-01-02T03:04:05Z">January 2</time><img src="https://images.example/post.jpg" alt="Synthetic scene"><ul aria-label="Comments"><li><a href="https://www.instagram.com/commenter/">Commenter</a><span dir="auto">Synthetic comment.</span><time datetime="2026-01-03T03:04:05Z">January 3</time></li></ul></article>', '<script type="application/ld+json">{"@type":"SocialMediaPosting","url":"https://www.instagram.com/p/Sample01/","interactionStatistic":[{"interactionType":"https://schema.org/LikeAction","userInteractionCount":15},{"interactionType":"CommentAction","userInteractionCount":"1.2K"}]}</script><script>window.session={token:"SYNTHETIC_DO_NOT_RETURN"}</script>'),
    expectedCount: 1,
  },
  comments: {
    request: { task: 'comment', url: 'https://www.instagram.com/p/Sample01/', limitPerId: 2 },
    html: shell('https://www.instagram.com/p/Sample01/', '<article><header><a href="https://www.instagram.com/sample.creator/">Sample Creator</a></header><h1>Synthetic caption only.</h1><ul aria-label="Comments"><li><a href="https://www.instagram.com/sample.creator/">Sample Creator</a><h1>Synthetic caption only.</h1><time datetime="2026-01-02">Jan 2</time></li><li><a href="https://www.instagram.com/commenter/">Commenter</a><span dir="auto">Synthetic comment.</span><time datetime="2026-01-03T03:04:05Z">Jan 3</time></li><li><a href="https://www.instagram.com/recommended/">Recommended</a><span dir="auto">Follow</span></li></ul></article><nav><ul><li><a href="https://www.instagram.com/navigation/">Navigation</a><span dir="auto">Should not appear.</span><time datetime="2026-01-03">Jan 3</time></li></ul></nav>'),
    expectedCount: 1,
  },
  mismatched: {
    request: { task: 'post', url: 'https://www.instagram.com/p/Sample01/', limitPerId: 2 },
    html: shell('https://www.instagram.com/p/Different/', '<article><h1>Wrong post.</h1></article>'),
    expectedError: 'canonical-mismatch',
  },
  genericPostShell: {
    request: { task: 'post', url: 'https://www.instagram.com/p/Sample01/', limitPerId: 2 },
    html: shell('https://www.instagram.com/p/Sample01/', '<h1>Log in</h1>', '<meta property="og:title" content="Instagram"><meta property="og:image" content="https://images.example/logo.jpg">'),
    expectedError: 'no-public-record',
  },
  genericProfileShell: {
    request: { task: 'profile', url: 'https://www.instagram.com/sample.creator/', limitPerId: 2 },
    html: shell('https://www.instagram.com/sample.creator/', '<header><h2>Log in</h2></header>', '<meta property="og:title" content="Instagram">'),
    expectedError: 'no-public-record',
  },
  postAlias: {
    request: { task: 'post', url: 'https://www.instagram.com/p/Sample01/', limitPerId: 2 },
    html: shell('https://www.instagram.com/reel/Sample01/', '<article><h1>Synthetic alias caption.</h1></article>'),
    expectedCount: 1,
  },
  multiArticleJsonFallback: {
    request: { task: 'post', url: 'https://www.instagram.com/p/Target01/', limitPerId: 2 },
    html: shell('https://www.instagram.com/p/Target01/', '<article><header><a href="https://www.instagram.com/other.author/">Other author</a></header><h1>Wrong recommendation caption</h1></article><article><header><a href="https://www.instagram.com/target.author/">Target author</a></header><h1>Correct target caption</h1></article>', '<script type="application/ld+json">{"@type":"SocialMediaPosting","url":"https://www.instagram.com/p/Target01/","articleBody":"Correct target caption","author":{"name":"Target author","url":"https://www.instagram.com/target.author/"}}</script>'),
    expectedCount: 1, expectedCaption: 'Correct target caption', expectedAuthor: 'target.author', expectedCaptionSource: 'json-ld.articleBody',
  },
  multiArticleTargetPermalink: {
    request: { task: 'post', url: 'https://www.instagram.com/p/Target01/', limitPerId: 2 },
    html: shell('https://www.instagram.com/p/Target01/', '<article><a href="https://www.instagram.com/p/Other01/">Other post</a><h1>Wrong recommendation caption</h1></article><article><header><a href="https://www.instagram.com/target.author/">Target author</a></header><a href="https://www.instagram.com/reel/Target01/">Target permalink</a><h1>Correct target caption</h1></article>'),
    expectedCount: 1, expectedCaption: 'Correct target caption', expectedAuthor: 'target.author', expectedCaptionSource: 'article.h1',
  },
  multiArticleAmbiguous: {
    request: { task: 'post', url: 'https://www.instagram.com/p/Target01/', limitPerId: 2 },
    html: shell('https://www.instagram.com/p/Target01/', '<article><h1>Unattributed first caption</h1></article><article><h1>Unattributed second caption</h1></article>'),
    expectedError: 'no-public-record',
  },
  duplicateComments: {
    request: { task: 'comment', url: 'https://www.instagram.com/p/Target01/', limitPerId: 2 },
    html: shell('https://www.instagram.com/p/Target01/', `<article><h1>Target caption</h1><ul aria-label="Comments">${comment('one')}${comment('one')}${comment('two')}</ul></article>`),
    expectedCount: 2, expectedTexts: ['one', 'two'],
  },
  invalidCommentsBeforeValid: {
    request: { task: 'comment', url: 'https://www.instagram.com/p/Target01/', limitPerId: 2 },
    html: shell('https://www.instagram.com/p/Target01/', `<article><h1>Target caption</h1><ul aria-label="Comments"><li><a href="https://www.instagram.com/commenter/">Commenter</a><span dir="auto">invalid date</span><time datetime="invalid">Invalid</time></li>${comment('one')}${comment('two')}</ul></article>`),
    expectedCount: 2, expectedTexts: ['one', 'two'],
  },
  login: {
    request: { task: 'profile', url: 'https://www.instagram.com/sample.creator/', limitPerId: 2 },
    html: '<!doctype html><body>Log in to continue</body>', expectedError: 'login-required',
  },
  challenge: {
    request: { task: 'profile', url: 'https://www.instagram.com/sample.creator/', limitPerId: 2 },
    html: '<!doctype html><body>Confirm you are human</body>', expectedError: 'challenge-required',
  },
};
