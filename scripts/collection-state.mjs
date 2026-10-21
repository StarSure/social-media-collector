import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertExternalOutput, csvCell, recordKey, writeCollection, parseLocalUrl } from './local-browser.mjs';
import { knownCount, publicCounters, recordBelongsToProfile } from './collection-quality.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
export function jobKey(spec) {
  return createHash('sha256').update(JSON.stringify({ platform: spec.platform, task: spec.task, source: spec.source, selection: spec.selection ?? 'embed', urls: spec.urls, limitPerId: spec.limitPerId, verifyWith: spec.verifyWith ?? {}, sourceRefs: spec.sourceRefs ?? {} })).digest('hex');
}

export function createCheckpoint(spec) {
  return { schemaVersion: 1, jobKey: jobKey(spec), runId: randomUUID(), startedAt: new Date().toISOString(), accounts: {} };
}

export function validateCheckpointAccount(spec, originalUrl, result) {
  if (!spec.urls.includes(originalUrl) || !Array.isArray(result?.records) || result.records.length > 100 || !result.source || (result.source.originalUrl ?? result.source.url) !== originalUrl || result.source.loginUsed !== false) throw fail('INVALID_CHECKPOINT', 'Checkpoint contains an account outside this anonymous job.');
  let resolved;
  try { resolved = parseLocalUrl(result.source.url, spec.platform, 'profile').url; } catch { throw fail('INVALID_CHECKPOINT', 'Checkpoint contains an invalid resolved profile.'); }
  const changed = resolved.toLowerCase() !== originalUrl.toLowerCase();
  const video = spec.verifyWith?.[originalUrl];
  if (changed || video && result.source.status === 'completed') {
    const evidence = result.source.resolution;
    const expectedId = video?.split('/').filter(Boolean).at(-1);
    const videoKey = value => { try { const url = new URL(value); return url.hostname.replace(/^www\./, '') + url.pathname.replace(/\/$/, ''); } catch { return null; } };
    if (!video || !evidence || videoKey(evidence.sourceVideoUrl) !== videoKey(video) || evidence.url !== resolved || evidence.videoId !== expectedId) throw fail('CHECKPOINT_SCOPE_MISMATCH', 'A changed author requires the configured source video and matching resolution evidence.');
  }
  if (result.records.some(record => !recordBelongsToProfile(record, resolved, spec.platform))) throw fail('INVALID_CHECKPOINT', 'Checkpoint video identity or owner does not match its source account.');
}

export async function loadCheckpoint(filename, spec) {
  const stat = await fs.stat(filename);
  if (stat.size > 16 * 1024 * 1024) throw fail('INVALID_CHECKPOINT', 'Checkpoint exceeds the supported size.');
  const value = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (value.schemaVersion !== 1 || value.jobKey !== jobKey(spec) || typeof value.runId !== 'string' || !value.accounts || typeof value.accounts !== 'object' || Array.isArray(value.accounts)) throw fail('CHECKPOINT_SCOPE_MISMATCH', 'Resume requires the same platform, source accounts, selection, quantity and verification links.');
  for (const [url, result] of Object.entries(value.accounts)) {
    validateCheckpointAccount(spec, url, result);
  }
  return value;
}

export async function saveCheckpoint(filename, checkpoint) {
  await assertExternalOutput(path.dirname(filename));
  try { if ((await fs.lstat(filename)).isSymbolicLink()) throw fail('INVALID_OUTPUT', 'A checkpoint file must not be a symlink.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ ...checkpoint, updatedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function readPreviousSnapshot(filename, spec) {
  const stat = await fs.stat(filename);
  if (stat.size > 32 * 1024 * 1024) throw fail('INVALID_SNAPSHOT', 'Previous snapshot exceeds the supported size.');
  const value = JSON.parse(await fs.readFile(filename, 'utf8'));
  const urls = value.requestedUrls ?? value.sources?.map(source => source.originalUrl ?? source.url);
  if (value.platform !== spec.platform || !Array.isArray(value.records) || !Array.isArray(urls) || urls.length !== spec.urls.length || !spec.urls.every(url => urls.includes(url))) throw fail('SNAPSHOT_SCOPE_MISMATCH', 'Compare snapshots from the same platform and source account list.');
  const profiles = [...spec.urls];
  for (const source of value.sources ?? []) {
    if (!spec.urls.includes(source.originalUrl ?? source.url)) throw fail('SNAPSHOT_SCOPE_MISMATCH', 'Previous snapshot includes a foreign source.');
    validateCheckpointAccount(spec, source.originalUrl ?? source.url, { source, records: [] });
    profiles.push(source.url);
  }
  if (value.records.some(record => !profiles.some(profile => recordBelongsToProfile(record, profile, spec.platform)))) throw fail('SNAPSHOT_SCOPE_MISMATCH', 'Previous snapshot contains a video outside its source accounts.');
  return value;
}

export function metricChanges(previous, current) {
  const prior = new Map((previous?.records ?? []).map(record => [recordKey(record), publicCounters(record)]));
  return current.records.map(value => {
    const record = publicCounters(value);
    const candidate = prior.get(recordKey(record));
    const old = candidate && typeof candidate.username === 'string' && candidate.username.toLowerCase() === record.username?.toLowerCase() ? candidate : null;
    const result = { platform: record.platform, id: record.id, username: record.username, url: record.url, previousCollectedAt: old?.collectedAt ?? null, collectedAt: record.collectedAt ?? current.collectedAt, baseline: old ? 'previous-snapshot' : 'new-video' };
    const ordered = old && Number.isFinite(Date.parse(old.collectedAt)) && Number.isFinite(Date.parse(result.collectedAt)) && Date.parse(result.collectedAt) > Date.parse(old.collectedAt);
    for (const metric of ['playCount', 'viewCount', 'likeCount', 'commentCount', 'shareCount', 'collectCount']) {
      result[metric] = record[metric] ?? null;
      result[`${metric}Previous`] = old?.[metric] ?? null;
      let delta = null;
      if (ordered && knownCount(record[metric]) && knownCount(old[metric])) {
        const difference = BigInt(record[metric]) - BigInt(old[metric]);
        delta = difference <= BigInt(Number.MAX_SAFE_INTEGER) && difference >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(difference) : difference.toString();
      }
      result[`${metric}Change`] = delta;
    }
    result.comparisonStatus = !old ? 'no-baseline' : !ordered ? 'snapshot-time-not-newer' : 'compared-known-counters-only';
    return result;
  });
}

async function writeRows(filename, rows) {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  await fs.writeFile(filename, '\ufeff' + [columns.map(csvCell).join(','), ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))].join('\r\n') + '\r\n');
}

export async function writeAnonymousCollection(result, outputDir, previous) {
  const exported = await writeCollection(result, outputDir);
  const directory = path.dirname(exported.files.dataFile);
  exported.files.accountsFile = path.join(directory, 'accounts.csv');
  await writeRows(exported.files.accountsFile, result.accountSummary);
  if (previous) {
    const changes = metricChanges(previous, result);
    exported.files.changesFile = path.join(directory, 'metric-changes.csv');
    exported.files.changesJsonFile = path.join(directory, 'metric-changes.json');
    await writeRows(exported.files.changesFile, changes);
    await fs.writeFile(exported.files.changesJsonFile, JSON.stringify(changes, null, 2) + '\n');
  }
  await fs.writeFile(exported.files.reportFile, JSON.stringify(exported, null, 2) + '\n');
  return exported;
}
