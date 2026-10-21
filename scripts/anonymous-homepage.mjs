#!/usr/bin/env node
// Fresh, ephemeral browser only: this runner never attaches to a user session.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './browser.mjs';
import { parseLocalUrl, assertExternalOutput, recordKey } from './local-browser.mjs';
import { collectTikTokHomepage } from './tiktok-homepage.mjs';
import { collectInstagramHomepage } from './instagram-homepage.mjs';
import { collectTikTokLatest, resolveTikTokVideoAuthor } from './tiktok-latest.mjs';
import { collectInstagramLatest, resolveInstagramVideoAuthor } from './instagram-latest.mjs';
import { assessAccount, accountSummary } from './collection-quality.mjs';
import { createCheckpoint, jobKey, loadCheckpoint, saveCheckpoint, readPreviousSnapshot, writeAnonymousCollection, validateCheckpointAccount } from './collection-state.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const help = `Anonymous account-homepage videos (Node 20+)
  node scripts/anonymous-homepage.mjs plan --spec job.json
  node scripts/anonymous-homepage.mjs collect --spec job.json [--browser /path/to/Chrome]
    [--resume /path/to/checkpoint.json] [--previous /path/to/prior/data.json]

Spec: {platform:"tiktok"|"instagram", task:"video", source:"author-links", urls:[], limitPerId,
       selection?:"latest"|"embed", verifyWith?:{profileUrl:videoUrl}, sourceRefs?:{profileUrl:["source row"]}, outputDir?}.
selection=latest uses the normal public profile and natural pagination (limit 1..100).
Latest coverage needs dated, matching public videos and verified listing order; sorting alone is insufficient.
Default embed mode retains the bounded selection: TikTok 1..10, Instagram 1..6.
No CDP, stored profile, account login, API key, proxy rotation, or browser download.
Instagram video_view_count is viewCount;
playCount remains separate and null if the platform does not supply play_count.
Output: JSON, CSV, accounts.csv, report and an atomic checkpoint outside the skill.
--resume continues the same task; restored records keep their original observation times.
--previous compares known counters against a prior snapshot; missing values are not zero.
`;

export function parseAnonymousArguments(argv) {
  const [command = 'help', ...args] = argv;
  const allowed = { help: [], plan: ['spec'], collect: ['spec', 'browser', 'resume', 'previous'] }[command];
  if (!allowed) throw fail('INVALID_ARGUMENT', 'Use help, plan, or collect.');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(args[i]);
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(options, match[1])) throw fail('INVALID_ARGUMENT', `Unknown or duplicate argument: ${args[i]}`);
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--')) throw fail('INVALID_ARGUMENT', `Missing value for --${match[1]}`);
    options[match[1]] = value;
  }
  if (command !== 'help' && !options.spec) throw fail('INVALID_ARGUMENT', '--spec is required.');
  return { command, options };
}

export function validateAnonymousSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_SPEC', 'Spec must be an object.');
  const fields = ['platform', 'task', 'source', 'urls', 'limitPerId', 'selection', 'verifyWith', 'sourceRefs', 'outputDir'];
  for (const field of Object.keys(input)) if (!fields.includes(field)) throw fail('INVALID_SPEC', `Unknown anonymous spec field: ${field}`);
  if (!['tiktok', 'instagram'].includes(input.platform) || input.task !== 'video' || input.source !== 'author-links') throw fail('UNSUPPORTED_TASK', 'Use tiktok|instagram/video/author-links for anonymous homepage videos.');
  if (input.selection !== undefined && !['latest', 'embed'].includes(input.selection)) throw fail('INVALID_SPEC', 'selection must be latest or embed.');
  const maximum = input.selection === 'latest' ? 100 : input.platform === 'tiktok' ? 10 : 6;
  if (!Number.isSafeInteger(input.limitPerId) || input.limitPerId < 1 || input.limitPerId > maximum) throw fail('INVALID_SPEC', `limitPerId must be an explicit integer from 1 to ${maximum}; the embed is a recent selection.`);
  if (!Array.isArray(input.urls) || !input.urls.length || input.urls.some(url => typeof url !== 'string')) throw fail('INVALID_SPEC', 'urls must be a nonempty list.');
  const urls = input.urls.map(url => parseLocalUrl(url, input.platform, 'profile').url);
  if (new Set(urls.map(url => url.toLowerCase())).size !== urls.length) throw fail('INVALID_SPEC', 'Duplicate source profiles must be resolved first.');
  const spec = { platform: input.platform, task: input.task, source: input.source, urls, limitPerId: input.limitPerId };
  if (input.selection !== undefined) spec.selection = input.selection;
  for (const field of ['verifyWith', 'sourceRefs']) {
    if (input[field] === undefined) continue;
    if (!input[field] || typeof input[field] !== 'object' || Array.isArray(input[field])) throw fail('INVALID_SPEC', `${field} must be keyed by source profile URL.`);
    spec[field] = {};
    for (const [key, value] of Object.entries(input[field])) {
      const canonical = parseLocalUrl(key, input.platform, 'profile').url;
      const original = urls.find(url => url.toLowerCase() === canonical.toLowerCase());
      if (!original || Object.hasOwn(spec[field], original)) throw fail('INVALID_SPEC', `${field} contains an unknown or duplicate source.`);
      if (field === 'sourceRefs') {
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length > 500)) throw fail('INVALID_SPEC', 'sourceRefs values must be lists of short source labels.');
        spec[field][original] = value;
      } else {
        let video;
        try { video = new URL(value); } catch { throw fail('INVALID_SPEC', 'verifyWith requires a public video URL.'); }
        const hosts = ['www.' + input.platform + '.com', input.platform + '.com'];
        const pattern = input.platform === 'tiktok' ? /^\/@[a-zA-Z0-9._]+\/video\/\d+\/?$/ : /^\/(?:p|reel|reels)\/[a-zA-Z0-9_-]+\/?$/;
        if (video.protocol !== 'https:' || !hosts.includes(video.hostname) || video.username || video.password || video.port || !pattern.test(video.pathname)) throw fail('INVALID_SPEC', 'verifyWith requires a public video URL on the selected platform.');
        spec[field][original] = video.origin + video.pathname;
      }
    }
  }
  if (input.outputDir !== undefined) {
    if (typeof input.outputDir !== 'string' || !input.outputDir.trim()) throw fail('INVALID_SPEC', 'outputDir must be a path.');
    spec.outputDir = path.resolve(input.outputDir);
  }
  return spec;
}

export async function collectAnonymousHomepages(spec, browser, options = {}) {
  const records = new Map();
  const sources = [];
  const checkpoint = options.checkpoint ?? createCheckpoint(spec);
  const persist = async (url, result) => {
    checkpoint.accounts[url] = result;
    if (options.onCheckpoint) await options.onCheckpoint(checkpoint);
  };
  for (const url of spec.urls) {
    const cached = checkpoint.accounts[url];
    if (cached) validateCheckpointAccount(spec, url, cached);
    let result;
    if (cached?.source.status === 'completed') {
      const checked = assessAccount(spec, cached.source, cached.records);
      if (checked.source.quality.meetsRequirements) result = { records: checked.records.map(record => ({ ...record, restoredFromCheckpoint: true })), source: { ...checked.source, resumed: true } };
    }
    if (!result) {
      let resolvedUrl = url;
      let resolution;
      try {
        if (spec.verifyWith?.[url]) {
          const resolve = spec.platform === 'tiktok' ? resolveTikTokVideoAuthor : resolveInstagramVideoAuthor;
          resolution = await resolve(browser, spec.verifyWith[url]);
          resolvedUrl = parseLocalUrl(resolution.url, spec.platform, 'profile').url;
        }
        const collect = spec.selection === 'latest' ? spec.platform === 'tiktok' ? collectTikTokLatest : collectInstagramLatest
          : spec.platform === 'tiktok' ? collectTikTokHomepage : collectInstagramHomepage;
        const raw = await collect(browser, {
          url: resolvedUrl, limitPerId: spec.limitPerId, resumeRecords: cached?.records ?? [],
          onProgress: async partial => persist(url, {
            records: partial,
            source: { url: resolvedUrl, originalUrl: url, status: 'partial', termination: 'interrupted', latestVerified: false, loginUsed: false, ...(resolution ? { resolution } : {}) },
          }),
        });
        result = assessAccount(spec, { ...raw.source, ...(resolvedUrl !== url ? { originalUrl: url } : {}), ...(resolution ? { resolution } : {}), sourceRefs: spec.sourceRefs?.[url] ?? [] }, raw.records);
      } catch (error) {
        if (['INVALID_OUTPUT', 'EACCES', 'ENOSPC', 'EROFS'].includes(error.code)) throw error;
        result = assessAccount(spec, { url: resolvedUrl, ...(resolvedUrl !== url ? { originalUrl: url } : {}), status: 'blocked', termination: error.code ?? 'COLLECTION_FAILED', error: error.message, loginUsed: false, ...(error.http ? { http: error.http } : {}), sourceRefs: spec.sourceRefs?.[url] ?? [] }, []);
      }
    }
    await persist(url, result);
    sources.push(result.source);
    for (const record of result.records) {
      const key = recordKey(record);
      const existing = records.get(key);
      records.set(key, { ...record, recordKey: key, sourceUrls: [...new Set([...(existing?.sourceUrls ?? []), url])], sourceRefs: [...new Set([...(existing?.sourceRefs ?? []), ...(spec.sourceRefs?.[url] ?? [])])] });
    }
    if (result.source.status !== 'completed' && !['recent-selection-exhausted', 'profile-selection-exhausted', 'required-metrics-unavailable', 'latest-order-unverified', 'requested-count-unavailable', 'no-new-visible-links', 'list-exhausted'].includes(result.source.termination)) break;
  }
  const completed = sources.length === spec.urls.length && sources.every(source => source.status === 'completed');
  const summary = accountSummary(spec, sources);
  return {
    schemaVersion: 1, status: completed ? 'completed' : records.size ? 'partial' : 'blocked',
    platform: spec.platform, task: spec.task, source: spec.source,
    collectedAt: new Date().toISOString(), loginUsed: false, userSessionRead: false,
    recordCount: records.size, requestedSources: spec.urls.length, processedSources: sources.length,
    requestedUrls: spec.urls, selection: spec.selection ?? 'embed', runId: checkpoint.runId, startedAt: checkpoint.startedAt,
    sources, records: [...records.values()], accountSummary: summary,
    acceptance: { requestedVideosPerAccount: spec.limitPerId, selection: spec.selection ?? 'embed', satisfiedAccounts: summary.filter(source => source.meetsRequirements).length, latest20Verified: spec.selection === 'latest' && spec.limitPerId >= 20 && completed && summary.every(source => source.latestVerified), restoredRecordCount: [...records.values()].filter(record => record.restoredFromCheckpoint).length, livePlatformAvailabilityGuaranteed: false },
    coverage: spec.selection === 'latest' ? 'normal public profile, observed natural pagination and publication dates; latest coverage must be verified per account'
      : spec.platform === 'tiktok' ? 'official creator embed: selection of at most 10 recent videos; no full-history pagination' : 'public profile embed selection only; no full-history pagination; at most 6 requested',
    metrics: spec.platform === 'tiktok' ? 'public detail SSR stats/statsV2 values as supplied; platform may round counts; missing values are null' : 'public embedded media fields only; playCount and viewCount are distinct; missing values are null',
  };
}

export async function findAnonymousBrowser(playwright, preferred) {
  const candidates = [preferred, process.env.SOCIAL_BROWSER_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
    playwright.chromium.executablePath()].filter(Boolean);
  if (preferred) { await fs.access(preferred); return preferred; }
  for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch {} }
  throw fail('BROWSER_MISSING', 'No installed Chrome/Chromium found. Use --browser; no browser is downloaded.');
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseAnonymousArguments(argv);
  if (command === 'help') { console.log(help); return; }
  const spec = validateAnonymousSpec(JSON.parse(await fs.readFile(path.resolve(options.spec), 'utf8')));
  if (spec.outputDir) await assertExternalOutput(spec.outputDir);
  if (command === 'plan') {
    console.log(JSON.stringify({ status: 'planned-only', collectionStarted: false, runner: 'anonymous-homepage', loginRequired: false, fullHistorySupported: false, latestCoverageGuaranteed: false, spec }, null, 2));
    return;
  }
  if (!spec.outputDir) throw fail('INVALID_SPEC', 'collect requires outputDir outside the skill directory.');
  const checkpoint = options.resume ? await loadCheckpoint(path.resolve(options.resume), spec) : createCheckpoint(spec);
  const checkpointFile = options.resume ? path.resolve(options.resume) : path.join(spec.outputDir, `checkpoint-${jobKey(spec).slice(0, 12)}.json`);
  const previous = options.previous ? await readPreviousSnapshot(path.resolve(options.previous), spec) : null;
  await saveCheckpoint(checkpointFile, checkpoint);
  const { playwright } = await loadPlaywright();
  const executablePath = await findAnonymousBrowser(playwright, options.browser);
  const browser = await playwright.chromium.launch({ headless: true, executablePath });
  try {
    const result = await collectAnonymousHomepages(spec, browser, { checkpoint, onCheckpoint: value => saveCheckpoint(checkpointFile, value) });
    result.execution = { headless: true, persistentProfile: false, context: 'fresh-anonymous', storageStateLoaded: false, connectedViaCDP: false };
    result.checkpointFile = checkpointFile;
    result.resumed = Boolean(options.resume);
    console.log(JSON.stringify(await writeAnonymousCollection(result, spec.outputDir, previous), null, 2));
    if (result.status !== 'completed') process.exitCode = 2;
  } finally { await browser.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ status: 'error', code: error.code ?? 'ERROR', error: error.message })); process.exitCode = 1; });
}
