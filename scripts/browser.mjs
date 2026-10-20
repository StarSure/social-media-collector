#!/usr/bin/env node
// This helper controls the bundled extension UI; it does not reimplement platform APIs.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(skillRoot, 'assets', 'extension');
const defaultProfile = path.join(os.homedir(), '.codex/state/social-media-collector/browser-profile');
const allowedSpecFields = new Set(['platform', 'task', 'source', 'mode', 'urls', 'keywords', 'limit', 'limitPerId', 'outputDir']);
const help = `Social Media Collector browser helper (Node 20+)\n
  node scripts/browser.mjs help
  node scripts/browser.mjs plan --spec /absolute/spec.json
  node scripts/browser.mjs preflight [--endpoint http://127.0.0.1:9336]
  node scripts/browser.mjs launch [--port 9337] [--profile /dedicated/empty/profile] [--browser /path/to/Chrome]
  node scripts/browser.mjs open --endpoint http://127.0.0.1:9337 --platform xiaohongshu --task TASK_ID
  node scripts/browser.mjs prepare --endpoint http://127.0.0.1:9337 --spec /absolute/spec.json
  node scripts/browser.mjs export --endpoint http://127.0.0.1:9337 --output-dir /absolute/output

Spec (unknown fields rejected): {platform, task, source?, mode?: "api"|"rpa", urls?: string[], keywords?: string[], limit?: integer, limitPerId?: integer, outputDir?: string}.
source means the original collectBy (e.g. keyword, links); mode means API/RPA.
plan is offline. preflight is read-only and never reads cookies/storage values.
launch creates an isolated browser and waits until closed. open navigates original memory-router UI.
prepare opens a form and reports its visible fields; it does NOT fill or submit collection.
For hidden-collect routes, use the original platform-page entry; required router state cannot be invented.
export requires an already completed original task and clicks its original Excel export button.
There is no CLI run command: collection uses the original form after checking source/mode/limits.
Dependencies: installed playwright, PLAYWRIGHT_PACKAGE, or bundled Codex runtime; no downloads/installation.\n`;

export function parseArguments(argv) {
  const [command = 'help', ...rest] = argv;
  const schemas = { help: [], plan: ['spec'], preflight: ['endpoint'], launch: ['port', 'profile', 'browser'], open: ['endpoint', 'platform', 'task'], prepare: ['endpoint', 'spec'], export: ['endpoint', 'output-dir'] };
  if (!Object.hasOwn(schemas, command)) throw new Error(`Unsupported command: ${command}. Use help; no automatic run command is implemented.`);
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
    if (!match || !schemas[command].includes(match[1])) throw new Error(`Unknown argument: ${argument}`);
    if (Object.hasOwn(options, match[1])) throw new Error(`Duplicate argument: --${match[1]}`);
    const value = match[2] ?? rest[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value: --${match[1]}`);
    options[match[1]] = value;
  }
  for (const field of ({ plan: ['spec'], open: ['platform', 'task'], prepare: ['spec'], export: ['output-dir'] }[command] || [])) {
    if (!options[field]) throw new Error(`Missing --${field}`);
  }
  return { command, options };
}

export function validateEndpoint(value = 'http://127.0.0.1:9336') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('CDP endpoint must be a loopback HTTP origin, e.g. http://127.0.0.1:9337');
  }
  return url.origin;
}

export function hostMatches(hostname, hosts) {
  const name = hostname.toLowerCase();
  return hosts.some(host => {
    const expected = host.toLowerCase().replace(/^\*\./, '');
    return name === expected || (host.startsWith('*.') && name.endsWith(`.${expected}`));
  });
}

export function selectTask(catalog, platformId, taskId) {
  const needle = String(platformId || '').toLowerCase();
  const platform = catalog.platforms.find(item => [item.id, item.name, ...(item.aliases || [])].some(name => String(name).toLowerCase() === needle));
  if (!platform) throw new Error(`Unknown platform: ${platformId}`);
  const task = platform.tasks.find(item => item.id === taskId);
  if (!task) throw new Error(`Unknown task ${taskId} for ${platform.id}; available: ${platform.tasks.map(item => item.id).join(', ')}`);
  return { platform, task };
}

export function validateSpec(spec, catalog) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Spec must be a JSON object');
  for (const field of Object.keys(spec)) if (!allowedSpecFields.has(field)) throw new Error(`Unknown spec field: ${field}`);
  if (typeof spec.platform !== 'string' || typeof spec.task !== 'string') throw new Error('platform and task must be strings');
  const { platform, task } = selectTask(catalog, spec.platform, spec.task);
  const normalized = { platform: platform.id, task: task.id };
  for (const key of ['urls', 'keywords']) {
    if (spec[key] !== undefined) {
      if (!Array.isArray(spec[key]) || !spec[key].length || spec[key].some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${key} must be a nonempty string array`);
      normalized[key] = spec[key].map(item => item.trim());
      if (new Set(normalized[key]).size !== normalized[key].length) throw new Error(`Duplicate ${key} must be resolved explicitly`);
    }
  }
  if (normalized.urls && normalized.keywords) throw new Error('urls and keywords cannot be combined in one task');
  for (const link of normalized.urls || []) {
    let url;
    try { url = new URL(link); } catch { throw new Error('Every urls item must be a full HTTP(S) URL; expand copied share text first'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !hostMatches(url.hostname, platform.hosts)) throw new Error(`URL does not belong to ${platform.id}: ${url.hostname}`);
  }
  const sources = (task.sources || []).map(source => typeof source === 'string' ? source : source.id ?? source.value);
  let source = spec.source;
  if (source !== undefined && typeof source !== 'string') throw new Error('source must be an original collectBy string');
  if (source === undefined) {
    const candidates = normalized.keywords ? sources.filter(item => ['keyword', 'keywords'].includes(item)) : normalized.urls ? sources.filter(item => item === 'links') : sources.length === 1 ? sources : [];
    if (candidates.length === 1) source = candidates[0];
    else if (sources.length) throw new Error(`Specify source explicitly; allowed: ${sources.join(', ')}`);
  }
  if (source !== undefined && !sources.includes(source)) throw new Error(`Unsupported source ${source}; allowed: ${sources.join(', ') || '(none; original form has no collectBy)'}`);
  if (normalized.keywords && !['keyword', 'keywords'].includes(source)) throw new Error(`keywords cannot be consumed by source ${source ?? '(none)'}`);
  if (normalized.urls && source && !source.includes('links')) throw new Error(`urls cannot be consumed by source ${source}`);
  if (['keyword', 'keywords'].includes(source) && !normalized.keywords) throw new Error('Keyword source requires keywords');
  if (source?.includes('links') && !normalized.urls) throw new Error('Link source requires urls');
  normalized.source = source ?? null;
  normalized.mode = spec.mode ?? 'api';
  if (!['api', 'rpa'].includes(normalized.mode)) throw new Error('mode must be api or rpa');
  for (const key of ['limit', 'limitPerId']) {
    if (spec[key] !== undefined) {
      if (!Number.isSafeInteger(spec[key]) || spec[key] < 1) throw new Error(`${key} must be a positive safe integer; unbounded zero is not accepted by this helper`);
      normalized[key] = spec[key];
    }
  }
  if (spec.outputDir !== undefined) {
    if (typeof spec.outputDir !== 'string' || !spec.outputDir.trim()) throw new Error('outputDir must be a nonempty path');
    normalized.outputDir = path.resolve(spec.outputDir);
    if (normalized.outputDir === skillRoot || normalized.outputDir.startsWith(`${skillRoot}${path.sep}`)) throw new Error('Store collected data outside the installed skill directory');
  }
  const requiresPageContext = task.route.includes('/hidden-collect/') || Boolean(task.requiresPageContext) || ['favorite', 'jingxuan', 'board-links', 'homefeed', 'ai-chat', 'red-video', 'search'].includes(source);
  if (!sources.length && !requiresPageContext && !normalized.urls) throw new Error('This original form requires urls');
  if (['homefeed', 'ai-chat', 'red-video', 'jingxuan'].includes(source) && normalized.mode !== 'rpa') throw new Error(`${source} is RPA-only in the original collector`);
  return { currentRequestVerified: false, status: 'planned-only', spec: normalized, platform: { id: platform.id, name: platform.name, homeUrl: platform.homeUrl }, route: task.route, requiresPageContext, verification: task.verification ?? platform.verification ?? 'not-live-verified', notes: task.notes ?? [], collectionStarted: false, automation: 'Original extension UI collection; helper does not submit forms' };
}

export async function loadPlaywright() {
  const candidates = ['playwright', process.env.PLAYWRIGHT_PACKAGE, path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean);
  for (const candidate of candidates) {
    try { const result = require(candidate); if (result.chromium?.connectOverCDP) return { playwright: result, dependency: candidate }; } catch {}
  }
  throw new Error('playwright is unavailable. Set PLAYWRIGHT_PACKAGE to an existing installed package. This helper does not download dependencies.');
}
const readCatalog = async () => JSON.parse(await fs.readFile(path.join(skillRoot, 'references/platforms.json'), 'utf8'));
const readSpec = async file => JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
export function redactReport(value) {
  if (Array.isArray(value)) return value.map(redactReport);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /cookie|token|authorization|password|secret/i.test(key) ? '[redacted]' : redactReport(item)]));
  if (typeof value === 'string' && /^https?:\/\//.test(value)) {
    try { const url = new URL(value); url.search = ''; url.hash = ''; url.username = ''; url.password = ''; return url.toString(); } catch {}
  }
  return value;
}
const output = value => console.log(JSON.stringify(redactReport(value), null, 2));

export function runtimeMismatches(expectedFiles, actualFiles) {
  const actual = new Map(actualFiles.map(item => [item.path, item.sha256]));
  return expectedFiles.filter(item => actual.get(item.path) !== item.sha256).map(item => item.path);
}

async function discover(browser) {
  const expectedManifest = JSON.parse(await fs.readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
  const runtimeManifest = JSON.parse(await fs.readFile(path.join(skillRoot, 'assets/runtime-manifest.json'), 'utf8'));
  const matches = [];
  matches.rejected = [];
  const seen = new Set();
  for (const context of browser.contexts()) {
    for (const worker of context.serviceWorkers()) {
      if (!worker.url().startsWith('chrome-extension://')) continue;
      const identity = await worker.evaluate(() => {
        const manifest = chrome.runtime.getManifest();
        return { id: chrome.runtime.id, name: manifest.name, version: manifest.version, versionName: manifest.version_name };
      }).catch(() => null);
      if (identity?.name !== expectedManifest.name || !identity.versionName?.includes('local') || seen.has(identity.id)) continue;
      // Only matching local extension identities are asked for their own bundled resources.
      const actualFiles = await worker.evaluate(async files => Promise.all(files.map(async file => {
        try {
          const response = await fetch(chrome.runtime.getURL(file.path));
          if (!response.ok) return { path: file.path, sha256: null };
          const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
          return { path: file.path, sha256: Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('') };
        } catch { return { path: file.path, sha256: null }; }
      })), runtimeManifest.files).catch(() => null);
      if (!actualFiles) continue; // A stale NoSW handle must not hide a later live worker with the same ID.
      const mismatches = runtimeMismatches(runtimeManifest.files, actualFiles);
      if (mismatches.length) matches.rejected.push({ id: identity.id, name: identity.name, mismatchedFiles: mismatches });
      else {
        seen.add(identity.id);
        matches.rejected = matches.rejected.filter(item => item.id !== identity.id);
        matches.push({ context, worker, identity, verifiedFiles: runtimeManifest.files.length });
      }
    }
  }
  return matches;
}

export function summarizeTab(rawUrl, catalog) {
  try {
    const url = new URL(rawUrl);
    const platform = catalog.platforms.find(item => hostMatches(url.hostname, item.hosts));
    // Never output token-bearing URL queries, paths, titles, or account IDs.
    return platform ? { platform: platform.id, origin: url.origin } : null;
  } catch { return null; }
}

async function withBrowser(endpoint, callback) {
  const { playwright } = await loadPlaywright();
  const browser = await playwright.chromium.connectOverCDP(validateEndpoint(endpoint), { timeout: 10000 });
  try { return await callback(browser); }
  finally { await browser.close(); } // Disconnects CDP; does not close the external browser.
}

async function preflight(options, catalog) {
  let dependency;
  try { dependency = (await loadPlaywright()).dependency; }
  catch (error) { return { status: 'dependency-unavailable', dependencyAvailable: false, error: error.message }; }
  return withBrowser(options.endpoint, async browser => {
    const matches = await discover(browser);
    const tabs = browser.contexts().flatMap(context => context.pages()).map(page => summarizeTab(page.url(), catalog)).filter(Boolean);
    return { status: matches.length ? 'ready-for-ui-check' : 'local-extension-not-found', endpoint: validateEndpoint(options.endpoint), dependencyAvailable: true, dependency, extensions: matches.map(({ identity, verifiedFiles }) => ({ id: identity.id, name: identity.name, version: identity.version, localCodeMatchesBundle: true, sha256VerifiedFiles: verifiedFiles })), rejectedExtensions: matches.rejected, platformTabs: tabs, collectionStarted: false, checks: ['No cookies, localStorage, IndexedDB, or saved session values read', 'No tabs opened and no platform requests initiated', 'Compared all 29 extension resources against assets/runtime-manifest.json; accepted candidates require every SHA-256 value to match'], limitation: 'Existing service workers only; a sleeping extension may not appear. Login and collection are not verified.' };
  });
}

async function singleExtension(browser) {
  const matches = await discover(browser);
  if (matches.length !== 1) throw new Error(`Expected one bundled local extension; found ${matches.length}. Run preflight or launch.`);
  return matches[0];
}

async function assertNoTaskPage(context, extensionId) {
  for (const page of context.pages().filter(page => page.url().startsWith(`chrome-extension://${extensionId}/sidepanel.html`))) {
    const onTask = await page.evaluate(() => window.router?.location?.pathname === '/general/task/run').catch(() => false);
    if (onTask) throw new Error('An original task page is open. Keep it intact; finish/export or leave it manually before opening a new task.');
  }
}

async function openTask(browser, platform, task) {
  if (task.route.includes('/hidden-collect/') || task.requiresPageContext) return { status: 'page-context-required', route: task.route, collectionStarted: false, instruction: 'Open the real platform page and use its original collection entry. This hidden route requires router state and cannot be opened directly.' };
  const { context, identity } = await singleExtension(browser);
  await assertNoTaskPage(context, identity.id);
  let platformPage = context.pages().find(page => {
    try { return hostMatches(new URL(page.url()).hostname, platform.hosts); } catch { return false; }
  });
  if (!platformPage) { platformPage = await context.newPage(); await platformPage.goto(platform.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
  const base = `chrome-extension://${identity.id}/sidepanel.html`;
  let panel = context.pages().find(page => page.url().startsWith(base));
  if (!panel) { panel = await context.newPage(); await panel.goto(base, { waitUntil: 'domcontentloaded' }); }
  await panel.waitForFunction(() => typeof window.router?.navigate === 'function');
  const localIdentity = await panel.evaluate(async () => {
    const response = await Promise.race([
      chrome.runtime.sendMessage({ type: 'socialLocalRequest', data: { url: '/ext/user/me', method: 'GET' } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Local identity handshake timed out')), 5000)),
    ]);
    return response?.result?.localOnly === true;
  });
  if (!localIdentity) throw new Error('Extension did not confirm localOnly identity');
  // Keep the preview in the background, so tabs.onActivated binds the actual platform tab.
  await platformPage.bringToFront();
  await panel.waitForTimeout(800);
  if (await panel.evaluate(() => window.platform?.code) !== platform.id) {
    const switchButton = panel.getByRole('button', { name: /^切\s*换$/ });
    if (await switchButton.count()) await switchButton.first().evaluate(button => button.click());
  }
  await panel.waitForFunction(id => window.platform?.code === id, platform.id, { timeout: 10000 });
  await panel.evaluate(route => window.router.navigate(route), task.route);
  await panel.waitForFunction(route => window.router?.location?.pathname === route, task.route);
  return { status: 'form-opened', extensionId: identity.id, platform: platform.id, task: task.id, route: task.route, collectionStarted: false, panel };
}

async function openOrPrepare(options, catalog, preparing) {
  const spec = preparing ? await readSpec(options.spec) : null;
  const plan = preparing ? validateSpec(spec, catalog) : null;
  const { platform, task } = selectTask(catalog, preparing ? plan.spec.platform : options.platform, preparing ? plan.spec.task : options.task);
  if (plan?.requiresPageContext) return { status: 'page-context-required', plan, collectionStarted: false, instruction: 'Use the original platform page collection entry; required router state and filters cannot be fabricated by this helper.' };
  return withBrowser(options.endpoint, async browser => {
    const { panel, ...result } = await openTask(browser, platform, task);
    if (!preparing || !panel) return { ...result, ...(plan ? { plan } : {}) };
    const fields = await panel.locator('form').evaluateAll(forms => forms.flatMap(form => Array.from(form.querySelectorAll('input,textarea,select')).map(field => ({ tag: field.tagName.toLowerCase(), id: field.id || null, type: field.getAttribute('type'), label: field.getAttribute('aria-label') || null })).filter(field => field.type !== 'hidden')));
    return { ...result, status: 'manual-form-required', plan, fields, instruction: 'Choose original source/collectBy and API/RPA controls, fill all spec inputs and limits, inspect selected fields, then submit the original form. No inputs have been filled and no collection has started.' };
  });
}

async function launch(options) {
  const port = Number(options.port || 9337);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('port must be an integer between 1024 and 65535');
  const profile = path.resolve(options.profile || defaultProfile);
  if (profile === skillRoot || profile.startsWith(`${skillRoot}${path.sep}`) || /(?:Google\/Chrome|google-chrome|chromium)(?:\/|$)/i.test(profile)) throw new Error('Use a dedicated profile outside the skill and existing Chrome profiles');
  await fs.mkdir(profile, { recursive: true });
  const marker = path.join(profile, '.social-media-collector-profile.json');
  const contents = await fs.readdir(profile);
  if (contents.length && !contents.includes(path.basename(marker))) throw new Error('Refusing an existing unmarked profile. Supply a new empty dedicated directory.');
  await fs.writeFile(marker, JSON.stringify({ purpose: 'social-media-collector-isolated-profile' }));
  const { playwright } = await loadPlaywright();
  const candidates = [options.browser, process.env.SOCIAL_BROWSER_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', playwright.chromium.executablePath()].filter(Boolean);
  let executablePath;
  for (const candidate of candidates) { try { await fs.access(candidate); executablePath = candidate; break; } catch {} }
  if (!executablePath) throw new Error('No installed Chrome/Chromium found; use --browser. No browser is downloaded automatically.');
  const context = await playwright.chromium.launchPersistentContext(profile, { executablePath, headless: false, ignoreDefaultArgs: ['--disable-extensions'], viewport: null, args: ['--enable-unsafe-extension-debugging', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check'] });
  try {
    // Chrome can return an extension ID even when loading is blocked by developer mode.
    // Enable it only in this explicitly isolated marked profile before loading.
    const settings = await context.newPage();
    await settings.goto('chrome://extensions/');
    const toggle = settings.locator('#devMode');
    await toggle.waitFor({ state: 'attached', timeout: 10000 });
    if (!await toggle.evaluate(element => element.checked)) await toggle.click();
    const session = await context.browser().newBrowserCDPSession();
    const loaded = await session.send('Extensions.loadUnpacked', { path: extensionPath });
    await session.detach();
    const state = await settings.evaluate(async id => {
      const info = await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true });
      const extension = info.find(item => item.id === id);
      return { extensionState: extension?.state ?? 'NOT_FOUND', developerMode: document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-toolbar')?.shadowRoot?.querySelector('#devMode')?.checked === true };
    }, loaded.id);
    if (state.extensionState !== 'ENABLED' || !state.developerMode) throw new Error(`Extension is blocked after load: ${state.extensionState}; developer mode: ${state.developerMode}`);
    let installed;
    for (let attempt = 0; attempt < 20; attempt++) {
      installed = await discover(context.browser());
      if (installed.some(item => item.identity.id === loaded.id)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!installed?.some(item => item.identity.id === loaded.id)) throw new Error('Loaded extension did not pass the full bundled-resource identity check');
    await settings.close();
    output({ status: 'isolated-browser-running', endpoint: `http://127.0.0.1:${port}`, extensionId: loaded.id, profile, extensionState: state.extensionState, developerMode: state.developerMode, sha256VerifiedFiles: installed[0].verifiedFiles, collectionStarted: false, instruction: 'Leave this process running. Use open/prepare from another shell; sign in to the target platform in this isolated browser.' });
    const stop = async () => { await context.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await new Promise(resolve => context.once('close', resolve));
  } catch (error) { await context.close(); throw error; }
}

async function exportExcel(options) {
  const target = path.resolve(options['output-dir']);
  if (target === skillRoot || target.startsWith(`${skillRoot}${path.sep}`)) throw new Error('Export outside the skill directory');
  return withBrowser(options.endpoint, async browser => {
    const { context, identity } = await singleExtension(browser);
    const panels = context.pages().filter(page => page.url().startsWith(`chrome-extension://${identity.id}/sidepanel.html`));
    const ready = [];
    for (const page of panels) {
      if (await page.evaluate(() => window.router?.location?.pathname === '/general/task/run' && Array.from(document.querySelectorAll('.smzs-tag')).some(tag => tag.textContent.trim() === '处理完成'))) ready.push(page);
    }
    if (ready.length !== 1) throw new Error(`Expected one completed original task panel; found ${ready.length}. Complete and inspect the task manually first.`);
    const panel = ready[0];
    const button = panel.getByText('导出Excel数据', { exact: true });
    if (await button.count() !== 1) throw new Error('Original Excel export action is unavailable or ambiguous');
    await fs.mkdir(target, { recursive: true });
    const downloadPath = await fs.mkdtemp(path.join(target, '.collector-download-'));
    const session = await browser.newBrowserCDPSession();
    let cancelDownload;
    try {
      await session.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath, eventsEnabled: true });
      const completed = new Promise((resolve, reject) => {
        let expected;
        const timer = setTimeout(() => { cleanup(); reject(new Error('Excel download did not complete within 60 seconds')); }, 60000);
        const begin = event => { if (/\.xlsx?$/i.test(event.suggestedFilename) && event.url.includes(`chrome-extension://${identity.id}/`)) expected = event; };
        const progress = event => {
          if (event.guid !== expected?.guid) return;
          if (event.state === 'completed') { cleanup(); resolve(expected); }
          if (event.state === 'canceled') { cleanup(); reject(new Error('Original Excel download was canceled')); }
        };
        const cleanup = () => { clearTimeout(timer); session.off('Browser.downloadWillBegin', begin); session.off('Browser.downloadProgress', progress); };
        cancelDownload = cleanup;
        session.on('Browser.downloadWillBegin', begin);
        session.on('Browser.downloadProgress', progress);
      });
      completed.catch(() => {});
      await button.evaluate(element => element.click());
      const download = await completed;
      const safeName = path.basename(download.suggestedFilename).replace(/[\x00-\x1f]/g, '_');
      const file = path.join(target, `${Date.now()}-${safeName}`);
      await fs.rename(path.join(downloadPath, download.guid), file);
      const data = await fs.readFile(file);
      const report = { status: 'original-excel-exported', file, bytes: data.length, sha256: hash(data), exportedAt: new Date().toISOString(), collectionStarted: false, limitation: 'Download verified; row count, headers, duplicates, and sampled field accuracy still require workbook inspection.' };
      const reportFile = `${file}.report.json`;
      await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
      return { ...report, reportFile };
    } finally {
      cancelDownload?.();
      await session.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
      await session.detach();
      await fs.rmdir(downloadPath).catch(() => {});
    }
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  if (command === 'help') { console.log(help); return; }
  if (command === 'launch') { await launch(options); return; }
  if (command === 'export') { output(await exportExcel(options)); return; }
  const catalog = await readCatalog();
  if (command === 'plan') output(validateSpec(await readSpec(options.spec), catalog));
  if (command === 'preflight') output(await preflight(options, catalog));
  if (command === 'open' || command === 'prepare') output(await openOrPrepare(options, catalog, command === 'prepare'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ status: 'error', error: error.message })); process.exitCode = 1; });
}
