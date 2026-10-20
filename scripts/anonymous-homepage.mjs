#!/usr/bin/env node
// Fresh, ephemeral browser only: this runner never attaches to a user session.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './browser.mjs';
import { parseLocalUrl, assertExternalOutput, recordKey, writeCollection } from './local-browser.mjs';
import { collectTikTokHomepage } from './tiktok-homepage.mjs';
import { collectInstagramHomepage } from './instagram-homepage.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const help = `Anonymous account-homepage videos (Node 20+)
  node scripts/anonymous-homepage.mjs plan --spec job.json
  node scripts/anonymous-homepage.mjs collect --spec job.json [--browser /path/to/Chrome]

Spec: {platform:"tiktok"|"instagram", task:"video", source:"author-links", urls:[], limitPerId, outputDir?}.
Uses official creator embeds for recent video links and public detail-page SSR for metrics.
The embed contains a selection of at most 10 recent videos; full history is unavailable.
No CDP, stored profile, account login, API key, proxy rotation, or browser download.
TikTok limit 1..10; Instagram limit 1..6. Instagram video_view_count is viewCount;
playCount remains separate and null if the platform does not supply play_count.
Output: JSON, CSV, report.json outside the skill. Missing metrics remain null and partial.
`;

export function parseAnonymousArguments(argv) {
  const [command = 'help', ...args] = argv;
  const allowed = { help: [], plan: ['spec'], collect: ['spec', 'browser'] }[command];
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
  const fields = ['platform', 'task', 'source', 'urls', 'limitPerId', 'outputDir'];
  for (const field of Object.keys(input)) if (!fields.includes(field)) throw fail('INVALID_SPEC', `Unknown anonymous spec field: ${field}`);
  if (!['tiktok', 'instagram'].includes(input.platform) || input.task !== 'video' || input.source !== 'author-links') throw fail('UNSUPPORTED_TASK', 'Use tiktok|instagram/video/author-links for anonymous homepage videos.');
  const maximum = input.platform === 'tiktok' ? 10 : 6;
  if (!Number.isSafeInteger(input.limitPerId) || input.limitPerId < 1 || input.limitPerId > maximum) throw fail('INVALID_SPEC', `limitPerId must be an explicit integer from 1 to ${maximum}; the embed is a recent selection.`);
  if (!Array.isArray(input.urls) || !input.urls.length || input.urls.some(url => typeof url !== 'string')) throw fail('INVALID_SPEC', 'urls must be a nonempty list.');
  const urls = input.urls.map(url => parseLocalUrl(url, input.platform, 'profile').url);
  if (new Set(urls.map(url => url.toLowerCase())).size !== urls.length) throw fail('INVALID_SPEC', 'Duplicate source profiles must be resolved first.');
  const spec = { platform: input.platform, task: input.task, source: input.source, urls, limitPerId: input.limitPerId };
  if (input.outputDir !== undefined) {
    if (typeof input.outputDir !== 'string' || !input.outputDir.trim()) throw fail('INVALID_SPEC', 'outputDir must be a path.');
    spec.outputDir = path.resolve(input.outputDir);
  }
  return spec;
}

export async function collectAnonymousHomepages(spec, browser) {
  const records = new Map();
  const sources = [];
  for (const url of spec.urls) {
    const collect = spec.platform === 'tiktok' ? collectTikTokHomepage : collectInstagramHomepage;
    const result = await collect(browser, { url, limitPerId: spec.limitPerId });
    sources.push(result.source);
    for (const record of result.records) {
      const key = recordKey(record);
      records.set(key, { ...record, recordKey: key, sourceUrls: [url] });
    }
    if (result.source.status !== 'completed' && !['recent-selection-exhausted', 'profile-selection-exhausted', 'required-metrics-unavailable'].includes(result.source.termination)) break;
  }
  const completed = sources.length === spec.urls.length && sources.every(source => source.status === 'completed');
  return {
    schemaVersion: 1, status: completed ? 'completed' : records.size ? 'partial' : 'blocked',
    platform: spec.platform, task: spec.task, source: spec.source,
    collectedAt: new Date().toISOString(), loginUsed: false, userSessionRead: false,
    recordCount: records.size, requestedSources: spec.urls.length, processedSources: sources.length,
    sources, records: [...records.values()],
    coverage: spec.platform === 'tiktok' ? 'official creator embed: selection of at most 10 recent videos; no full-history pagination' : 'public profile embed selection only; no full-history pagination; at most 6 requested',
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
    console.log(JSON.stringify({ status: 'planned-only', collectionStarted: false, runner: 'anonymous-homepage', loginRequired: false, fullHistorySupported: false, spec }, null, 2));
    return;
  }
  if (!spec.outputDir) throw fail('INVALID_SPEC', 'collect requires outputDir outside the skill directory.');
  const { playwright } = await loadPlaywright();
  const executablePath = await findAnonymousBrowser(playwright, options.browser);
  const browser = await playwright.chromium.launch({ headless: true, executablePath });
  try {
    const result = await collectAnonymousHomepages(spec, browser);
    console.log(JSON.stringify(await writeCollection(result, spec.outputDir), null, 2));
    if (result.status !== 'completed') process.exitCode = 2;
  } finally { await browser.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ status: 'error', code: error.code ?? 'ERROR', error: error.message })); process.exitCode = 1; });
}
