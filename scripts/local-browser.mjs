#!/usr/bin/env node
// Local browser collectors. No data-provider API or platform credentials are exported.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, validateEndpoint, skillRoot } from './browser.mjs';
import { readTikTokProfile } from './tiktok-page.mjs';
import { parseInstagramUrl, readInstagramPage } from './instagram-page.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const fields = new Set(['platform', 'task', 'source', 'urls', 'limitPerId', 'outputDir']);
const help = `Local browser collection (Node 20+)
  node scripts/local-browser.mjs plan --spec job.json
  node scripts/local-browser.mjs collect --endpoint http://127.0.0.1:9337 --spec job.json

TikTok: task=author, source=links; public profile only.
Instagram: task=profile, source=links; task=post, source=links|author-links;
           task=comment, source=links. Posts by author and comments require limitPerId.
Spec fields: platform, task, source, urls, limitPerId?, outputDir?.
collect requires outputDir outside the skill. It navigates only new, owned tabs.
Use browser.mjs launch to start a dedicated browser. Login stays in that browser.
No private API, paid provider, keyword search, scheduler, or resume support is added.
Instagram selectors are offline-tested; authenticated live validation remains pending.
`;

export function parseLocalArguments(argv) {
  const [command = 'help', ...args] = argv;
  const allowed = { help: [], plan: ['spec'], collect: ['endpoint', 'spec'] }[command];
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
  if (command === 'collect' && !options.endpoint) throw fail('INVALID_ARGUMENT', '--endpoint is required; connect to your dedicated browser.');
  if (options.endpoint) options.endpoint = validateEndpoint(options.endpoint);
  return { command, options };
}

export function parseLocalUrl(value, platform, kind) {
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_URL', 'Use a complete HTTPS platform URL.'); }
  const hosts = platform === 'instagram' ? ['www.instagram.com', 'instagram.com'] : ['www.tiktok.com', 'tiktok.com'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) throw fail('INVALID_URL', 'URL must belong to the selected platform.');
  if (platform === 'tiktok') {
    const match = /^\/@([a-zA-Z0-9._]+)\/?$/.exec(url.pathname);
    if (!match || kind !== 'profile') throw fail('INVALID_URL', 'This local TikTok collector accepts profile URLs only.');
    return { url: `https://www.tiktok.com/@${match[1]}`, username: match[1] };
  }
  url.pathname = url.pathname.replace(/^\/reels\//, '/reel/');
  const parsed = parseInstagramUrl(url.href);
  if (parsed.kind !== kind) throw fail('INVALID_URL', `Use an Instagram ${kind} URL.`);
  return parsed;
}

export function validateLocalSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_SPEC', 'Spec must be an object.');
  for (const field of Object.keys(input)) if (!fields.has(field)) throw fail('INVALID_SPEC', `Unknown local spec field: ${field}`);
  if (!['instagram', 'tiktok'].includes(input.platform)) throw fail('INVALID_SPEC', 'Local collectors support instagram or tiktok.');
  const source = input.source ?? 'links';
  const supported = input.platform === 'tiktok' ? input.task === 'author' && source === 'links'
    : input.task === 'profile' && source === 'links' || input.task === 'post' && ['links', 'author-links'].includes(source) || input.task === 'comment' && source === 'links';
  if (!supported) throw fail('UNSUPPORTED_TASK', 'This task/source is not implemented in the local collector.');
  if (!Array.isArray(input.urls) || !input.urls.length || input.urls.some(url => typeof url !== 'string')) throw fail('INVALID_SPEC', 'urls must be a nonempty list.');
  const kind = input.task === 'author' || input.task === 'profile' || source === 'author-links' ? 'profile' : 'post';
  const urls = input.urls.map(url => parseLocalUrl(url, input.platform, kind).url);
  if (new Set(urls.map(url => kind === 'profile' ? url.toLowerCase() : url)).size !== urls.length) throw fail('INVALID_SPEC', 'Duplicate sources must be resolved first.');
  if (input.limitPerId !== undefined && (!Number.isSafeInteger(input.limitPerId) || input.limitPerId < 1)) throw fail('INVALID_SPEC', 'limitPerId must be a positive integer.');
  if ((source === 'author-links' || input.task === 'comment') && input.limitPerId === undefined) throw fail('INVALID_SPEC', 'Set an explicit limitPerId for list/comment collection.');
  const spec = { platform: input.platform, task: input.task, source, urls, limitPerId: input.limitPerId ?? 1 };
  if (input.outputDir !== undefined) {
    if (typeof input.outputDir !== 'string' || !input.outputDir.trim()) throw fail('INVALID_SPEC', 'outputDir must be a path.');
    spec.outputDir = path.resolve(input.outputDir);
    if (spec.outputDir === skillRoot || spec.outputDir.startsWith(skillRoot + path.sep)) throw fail('INVALID_SPEC', 'Store collected data outside the skill directory.');
  }
  return spec;
}

export function recordKey(record) {
  const natural = record.id ?? (record.type === 'comment' ? null : record.url);
  if (natural) return `${record.platform}:${record.type}:${natural}`;
  const postUrl = record.postUrl ?? record.url;
  const username = record.username ?? record.author?.username;
  if (record.type === 'comment' && postUrl && username && record.text && record.publishedAt) {
    const digest = createHash('sha256').update(JSON.stringify([postUrl, username, record.publishedAt, record.text])).digest('hex');
    return `${record.platform}:comment:derived:${digest}`;
  }
  throw fail('RECORD_ID_MISSING', 'Cannot reliably identify this record; it is not counted.');
}

export function csvCell(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const safe = /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export async function assertExternalOutput(outputDir) {
  const requested = path.resolve(outputDir);
  const physicalRoot = await fs.realpath(skillRoot);
  let ancestor = requested;
  const missing = [];
  for (;;) {
    try {
      const physical = path.join(await fs.realpath(ancestor), ...missing);
      if (physical === physicalRoot || physical.startsWith(physicalRoot + path.sep)) throw fail('INVALID_OUTPUT', 'The physical output directory is inside the skill; choose an external directory.');
      return requested;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

export async function writeCollection(result, outputDir) {
  await assertExternalOutput(outputDir);
  const directory = path.join(outputDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(directory, { recursive: true });
  const dataFile = path.join(directory, 'data.json');
  const csvFile = path.join(directory, 'data.csv');
  const reportFile = path.join(directory, 'report.json');
  await fs.writeFile(dataFile, JSON.stringify(result, null, 2) + '\n');
  const columns = [...new Set(result.records.flatMap(record => Object.keys(record)))];
  const rows = [columns.map(csvCell).join(','), ...result.records.map(record => columns.map(column => csvCell(record[column])).join(','))];
  await fs.writeFile(csvFile, '\ufeff' + rows.join('\r\n') + '\r\n');
  const { records, ...report } = result;
  const files = { dataFile, csvFile, reportFile };
  await fs.writeFile(reportFile, JSON.stringify({ ...report, files }, null, 2) + '\n');
  return { ...report, files };
}

async function navigate(page, url, platform) {
  let response;
  try { response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
  catch (error) { throw fail('NAVIGATION_FAILED', `Page navigation failed: ${error.name ?? 'Error'}`); }
  const status = response?.status();
  if (status === 429) throw fail('RATE_LIMITED', 'The platform returned HTTP 429. Stop and try later.');
  if (status === 403) throw fail('BLOCKED_HTTP_403', 'The platform denied access (HTTP 403).');
  if (status === 404) throw fail('NOT_FOUND', 'The requested page was not found.');
  if (status >= 400) throw fail('HTTP_ERROR', `The platform returned HTTP ${status}.`);
  const current = new URL(page.url());
  if (!['www.' + platform + '.com', platform + '.com'].includes(current.hostname)) throw fail('UNEXPECTED_REDIRECT', 'The page redirected outside the selected platform.');
  if (/\/(?:accounts\/login|login|signup)(?:\/|$)/.test(current.pathname)) throw fail('LOGIN_REQUIRED', 'Sign in to the platform in your dedicated browser before collecting.');
  if (/\/(?:challenge|checkpoint)(?:\/|$)/.test(current.pathname)) throw fail('CHALLENGE_REQUIRED', 'Complete the platform challenge manually before collecting.');
  await page.waitForTimeout(1500);
}

async function scrollPage(page) {
  await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 600)));
  await page.waitForTimeout(1500);
}

export async function collectWithContext(spec, context) {
  const records = new Map();
  const sources = [];
  const pages = [];
  const networkFailures = [];
  const makePage = async () => {
    const page = await context.newPage();
    pages.push(page);
    page.on('response', response => {
      const request = response.request();
      let url;
      try { url = new URL(response.url()); } catch { return; }
      if (['fetch', 'xhr'].includes(request.resourceType()) && ['instagram.com', 'www.instagram.com', 'www.tiktok.com', 'tiktok.com'].includes(url.hostname) && [401, 403, 429].includes(response.status())) {
        networkFailures.push({ status: response.status(), path: url.pathname });
      }
    });
    return page;
  };
  const add = (record, sourceUrl) => {
    const key = recordKey(record);
    const old = records.get(key);
    if (old) old.sourceUrls = [...new Set([...old.sourceUrls, sourceUrl])];
    else records.set(key, { ...record, collectedAt: record.collectedAt ?? new Date().toISOString(), recordKey: key, sourceUrls: [sourceUrl] });
    return key;
  };
  let page;
  let details;
  try {
    page = await makePage();
    for (const sourceUrl of spec.urls) {
      const source = { url: sourceUrl, requestedCount: spec.source === 'author-links' || spec.task === 'comment' ? spec.limitPerId : 1, actualCount: 0, status: 'pending', termination: null };
      sources.push(source);
      const seen = new Set();
      const startFailures = networkFailures.length;
      try {
        await navigate(page, sourceUrl, spec.platform);
        if (spec.platform === 'tiktok') {
          const read = await readTikTokProfile(page, parseLocalUrl(sourceUrl, 'tiktok', 'profile').username);
          for (const record of read.records) seen.add(add(record, sourceUrl));
          source.evidence = read.evidence;
        } else if (spec.source === 'author-links') {
          const visited = new Set();
          let emptyPasses = 0;
          while (seen.size < spec.limitPerId && emptyPasses < 3) {
            const read = await readInstagramPage(page, { task: 'profile', url: sourceUrl, limitPerId: spec.limitPerId });
            source.evidence = read.evidence;
            const links = (read.links ?? []).map(link => typeof link === 'string' ? link : link.url).filter(Boolean);
            let fresh = 0;
            for (const link of links) {
              const target = parseLocalUrl(link, 'instagram', 'post').url;
              if (visited.has(target)) continue;
              visited.add(target);
              fresh++;
              details ??= await makePage();
              await navigate(details, target, 'instagram');
              const post = await readInstagramPage(details, { task: 'post', url: target, limitPerId: 1 });
              for (const record of post.records) {
                const expectedAuthor = parseLocalUrl(sourceUrl, 'instagram', 'profile').username;
                if (record.author?.username?.toLowerCase() !== expectedAuthor.toLowerCase()) throw fail('AUTHOR_MISMATCH', 'A discovered post is not confirmed to belong to the requested profile.');
                if (seen.size < spec.limitPerId) seen.add(add(record, sourceUrl));
              }
              if (seen.size === spec.limitPerId) break;
            }
            emptyPasses = fresh ? 0 : emptyPasses + 1;
            if (seen.size < spec.limitPerId && emptyPasses < 3) {
              if (networkFailures.length > startFailures) throw fail('LIST_REQUEST_BLOCKED', 'A page list request was denied or rate-limited.');
              await scrollPage(page);
            }
          }
          source.termination = seen.size === spec.limitPerId ? 'requested-limit' : 'no-new-visible-links';
        } else {
          let emptyPasses = 0;
          do {
            const before = seen.size;
            const read = await readInstagramPage(page, { task: spec.task, url: sourceUrl, limitPerId: spec.limitPerId });
            source.evidence = read.evidence;
            for (const record of read.records) if (seen.size < source.requestedCount) seen.add(add(record, sourceUrl));
            if (spec.task !== 'comment' || seen.size === source.requestedCount) break;
            emptyPasses = seen.size === before ? emptyPasses + 1 : 0;
            if (emptyPasses < 3) {
              if (networkFailures.length > startFailures) throw fail('LIST_REQUEST_BLOCKED', 'A page comment request was denied or rate-limited.');
              await scrollPage(page);
            }
          } while (emptyPasses < 3);
          source.termination = seen.size === source.requestedCount ? 'requested-limit' : 'no-new-visible-comments';
        }
        source.actualCount = seen.size;
        source.status = seen.size === source.requestedCount ? 'completed' : 'partial';
        source.termination ??= 'single-page';
      } catch (error) {
        source.actualCount = seen.size;
        source.status = seen.size ? 'partial' : 'blocked';
        source.termination = error.code ?? 'COLLECTION_FAILED';
        source.error = error.message;
        break; // No account switching or repeated attempts after a blocker.
      }
    }
  } finally {
    for (const owned of pages) await owned.close().catch(() => {});
  }
  const completed = sources.length === spec.urls.length && sources.every(source => source.status === 'completed');
  return { schemaVersion: 1, status: completed ? 'completed' : records.size ? 'partial' : 'blocked', platform: spec.platform, task: spec.task, source: spec.source, collectedAt: new Date().toISOString(), recordCount: records.size, requestedSources: spec.urls.length, processedSources: sources.length, sources, records: [...records.values()], networkFailures, coverage: spec.platform === 'instagram' ? 'page-visible-fields; pagination completeness not guaranteed' : 'public profile SSR only', verification: spec.platform === 'instagram' ? 'offline-tested; authenticated live verification pending' : 'adapter has a public anonymous profile smoke test; this run is independently reported' };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseLocalArguments(argv);
  if (command === 'help') { console.log(help); return; }
  const spec = validateLocalSpec(JSON.parse(await fs.readFile(path.resolve(options.spec), 'utf8')));
  if (command === 'plan') {
    console.log(JSON.stringify({ status: 'planned-only', collectionStarted: false, runner: 'local-browser', spec, requiresExtension: false, instagramLiveVerified: false }, null, 2));
    return;
  }
  if (!spec.outputDir) throw fail('INVALID_SPEC', 'collect requires outputDir outside the skill directory.');
  await assertExternalOutput(spec.outputDir);
  const { playwright } = await loadPlaywright();
  const browser = await playwright.chromium.connectOverCDP(options.endpoint, { timeout: 10000 });
  try {
    const contexts = browser.contexts();
    if (contexts.length !== 1) throw fail('AMBIGUOUS_BROWSER', 'Expected one dedicated browser context.');
    const result = await collectWithContext(spec, contexts[0]);
    console.log(JSON.stringify(await writeCollection(result, spec.outputDir), null, 2));
    if (result.status !== 'completed') process.exitCode = 2;
  } finally { await browser.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ status: 'error', code: error.code ?? 'ERROR', error: error.message })); process.exitCode = 1; });
}
