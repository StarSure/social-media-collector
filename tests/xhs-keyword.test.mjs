import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Synthetic ID fixture reproducing the observed cross-page duplicate pattern.
// Preserve page 1's 20 notes and page 2's first 6: page 2 repeats page 1's first ID.
const capturedIds = [
  ['000000000000000000000001', '000000000000000000000002', '000000000000000000000003',
    '000000000000000000000004', '000000000000000000000005', '000000000000000000000006',
    '000000000000000000000007', '000000000000000000000008', '000000000000000000000009',
    '00000000000000000000000a', '00000000000000000000000b', '00000000000000000000000c',
    '00000000000000000000000d', '00000000000000000000000e', '00000000000000000000000f',
    '000000000000000000000010', '000000000000000000000011', '000000000000000000000012',
    '000000000000000000000013', '000000000000000000000014'],
  ['000000000000000000000015', '000000000000000000000001', '000000000000000000000016',
    '000000000000000000000017', '000000000000000000000018', '000000000000000000000019'],
];

const note = (id) => ({ id, model_type: 'note', xsec_token: 'fixture', note_card: { user: {} } });
const page = (ids, has_more = true) => ({ items: ids.map(note), has_more });

const targets = [
  { name: 'sidepanel', file: '../assets/extension/chunks/sidepanel-BdTwSbFs.js',
    start: 'async function $L(', end: 'async function ou(', symbol: '$L' },
  { name: 'content', file: '../assets/extension/content-scripts/content.js',
    start: 'async function kXe(', end: 'class V0 extends', symbol: 'kXe' },
];

function extract(source, target) {
  const start = source.indexOf(target.start);
  assert.ok(start >= 0, `${target.name}: collector anchor exists`);
  assert.equal(source.indexOf(target.start, start + 1), -1, `${target.name}: anchor is unique`);
  const end = source.indexOf(target.end, start);
  assert.ok(end > start, `${target.name}: collector end exists`);
  return source.slice(start, end);
}

function harness(source, target, pagesByKeyword) {
  const store = { getState: () => ({ hostname: 'www.xiaohongshu.com' }) };
  const context = {
    St: store, ti: store,
    JM() {}, CXe() {},
    fr: { SEARCH_NOTES: 'search_notes' }, Kn: { SEARCH_NOTES: 'search_notes' },
    Vt: (items, count) => items.slice(0, count),
    Dr: (items, count) => items.slice(0, count),
  };
  vm.runInNewContext(`${extract(source, target)};globalThis.collect = ${target.symbol};`, context);
  const requests = [];
  const additions = [];
  const records = [];
  const task = {
    records,
    getCompleted: () => records.length,
    async apiWrapper(_api, request) {
      requests.push({ keyword: request.keyword, page: request.page });
      const data = pagesByKeyword[request.keyword]?.[request.page - 1];
      assert.ok(data, `unexpected page request: ${request.keyword}/${request.page}`);
      return structuredClone(data);
    },
    async addRecord(input) {
      additions.push({ id: input.uniqueId, keyword: input.keyword });
      // Match rn.addRecord's keyword + uniqueId deduplication and return contract.
      const existing = records.find((record) => record.note_id === input.uniqueId);
      if (existing) {
        existing.search_keywords.push(input.keyword);
        return existing;
      }
      const record = { note_id: input.uniqueId, search_keywords: [input.keyword] };
      records.push(record);
      return record;
    },
  };
  return { records, requests, additions,
    collect: (keyword, limit) => context.collect.call(task, { keyword, limit, note_type: 0, sort: 'general' }) };
}

for (const target of targets) {
  const source = await readFile(new URL(target.file, import.meta.url), 'utf8');

  test(`${target.name}: captured cross-page duplicate still yields 25 unique notes`, async () => {
    const first = page(capturedIds[0]);
    first.items.splice(6, 0, { id: 'recommendation-1', model_type: 'rec_query' });
    first.items.splice(16, 0, { id: 'recommendation-2', model_type: 'rec_query' });
    const app = harness(source, target, { 小学语文: [first, page(capturedIds[1])] });
    await app.collect('小学语文', 25);
    assert.equal(app.records.length, 25);
    assert.equal(new Set(app.records.map((record) => record.note_id)).size, 25);
    assert.ok(app.records.some((record) => record.note_id === '000000000000000000000019'));
    assert.deepEqual(app.requests.map((request) => request.page), [1, 2]);
    assert.equal(app.additions.length, 25, 'duplicate is skipped before addRecord');
  });

  test(`${target.name}: duplicates within the first page do not consume the limit`, async () => {
    const app = harness(source, target, { alpha: [page(['a', 'a', 'b']), page(['b', 'c', 'd'])] });
    await app.collect('alpha', 3);
    assert.deepEqual(app.records.map((record) => record.note_id), ['a', 'b', 'c']);
    assert.deepEqual(app.additions.map((record) => record.id), ['a', 'b', 'c']);
  });

  test(`${target.name}: each keyword has its own quota while shared IDs merge`, async () => {
    const app = harness(source, target, { alpha: [page(['a', 'a', 'b', 'c'])], beta: [page(['b', 'b', 'd', 'e'])] });
    await app.collect('alpha', 2);
    await app.collect('beta', 2);
    assert.deepEqual(app.records.map((record) => record.note_id), ['a', 'b', 'd']);
    assert.deepEqual(app.records.find((record) => record.note_id === 'b').search_keywords, ['alpha', 'beta']);
    for (const keyword of ['alpha', 'beta']) {
      assert.equal(new Set(app.additions.filter((record) => record.keyword === keyword).map((record) => record.id)).size, 2);
    }
    assert.deepEqual(app.requests, [{ keyword: 'alpha', page: 1 }, { keyword: 'beta', page: 1 }]);
  });

  test(`${target.name}: has_more=false stops below the requested limit`, async () => {
    const app = harness(source, target, { alpha: [page(['a', 'a', 'b'], false)] });
    await app.collect('alpha', 5);
    assert.deepEqual(app.records.map((record) => record.note_id), ['a', 'b']);
    assert.equal(app.requests.length, 1);
  });

  test(`${target.name}: an empty page terminates even with has_more=true`, async () => {
    const app = harness(source, target, { alpha: [page(['a']), page([])] });
    await app.collect('alpha', 5);
    assert.deepEqual(app.records.map((record) => record.note_id), ['a']);
    assert.deepEqual(app.requests.map((request) => request.page), [1, 2]);
  });
}
