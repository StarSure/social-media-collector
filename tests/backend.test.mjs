import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/extension/local-backend.js', import.meta.url), 'utf8');

function harness({ database = {}, promiseStorage = false, storageError = null } = {}) {
  let listener;
  const runtime = {
    onMessage: { addListener(fn) { listener = fn; } },
    getManifest() { return { version: '3.6.1' }; }
  };
  const execute = (action, callback) => {
    if (promiseStorage) return storageError ? Promise.reject(new Error(storageError)) : Promise.resolve().then(action);
    setTimeout(() => {
      runtime.lastError = storageError ? { message: storageError } : undefined;
      callback(storageError ? undefined : action());
      runtime.lastError = undefined;
    }, 1);
  };
  const chrome = {
    runtime,
    storage: { local: {
      get(key, callback) { return execute(() => structuredClone({ [key]: database[key] }), callback); },
      set(value, callback) { return execute(() => Object.assign(database, structuredClone(value)), callback); }
    } }
  };
  vm.runInNewContext(source, { chrome, URL, Date, Promise });
  return {
    database,
    unrelated: () => listener({ type: 'other' }, {}, () => assert.fail('wrong response')),
    request(data) {
      return new Promise((resolve) => {
        assert.equal(listener({ type: 'socialLocalRequest', data }, {}, (value) => resolve(structuredClone(value))), true);
      });
    }
  };
}

test('uses a distinct local identity and produces no original-service token', async () => {
  const app = harness();
  assert.equal(app.unrelated(), undefined);
  const { result } = await app.request({ url: '/ext/user/me', platform: 'xiaohongshu' });
  assert.equal(result.id, 'local');
  assert.equal(result.platform, 'xiaohongshu');
  assert.equal(result.localOnly, true);
  assert.equal(result.cloudSyncEnabled, false);
  const subscriptions = (await app.request({ url: '/ext/user/vip/status' })).result;
  assert.deepEqual(subscriptions, []);
  assert.deepEqual(subscriptions.filter((item) => item.status === 'active').map((item) => item.platform), []);
  for (const route of ['login', 'logout', 'refresh_token']) {
    const { result: auth } = await app.request({ url: `/ext/auth/${route}`, method: 'POST' });
    assert.equal(auth.authenticated, false);
    assert.equal(auth.access_token, undefined);
  }
});

test('serializes concurrent writes, preserves records across worker restarts, and filters changed storage', async () => {
  const app = harness();
  const responses = await Promise.all(Array.from({ length: 16 }, (_, i) => app.request({
    url: '/ext/user/storage', method: 'POST', data: { key: `key-${i}`, value: { i }, version: 2, modifiedAt: i + 1 }
  })));
  assert.ok(responses.every((response) => response.result));
  const all = await app.request({ url: '/ext/user/storage' });
  assert.equal(all.result.length, 16);
  const after = await app.request({ url: '/ext/user/storage', params: { updatedAtFrom: responses[7].result.updatedAt } });
  assert.equal(after.result.length, 8);
  const restarted = harness({ database: app.database });
  assert.equal((await restarted.request({ url: '/ext/user/storage' })).result.length, 16);
  assert.deepEqual(Object.keys(app.database), ['socialLocalBackend']);
});

test('template CRUD retains scope and identity, and unavailable public sharing fails explicitly', async () => {
  const app = harness({ promiseStorage: true });
  for (const route of ['field-template', 'data-filter-template']) {
    const url = `/ext/user/${route}`;
    const created = (await app.request({ url, method: 'POST', data: {
      name: '测试模板', platform: 'douyin', type: 'video', config: { keys: ['title'] }
    } })).result;
    assert.ok(created.id > 0);
    assert.equal(created.shareEnabled, false);
    assert.equal((await app.request({ url, params: { platform: 'bilibili' } })).result.length, 0);
    assert.equal((await app.request({ url, params: { platform: 'douyin', type: 'video' } })).result.length, 1);
    const sharing = await app.request({ url: `${url}/${created.id}/share`, method: 'POST' });
    assert.equal(sharing.error.status, 501);
    assert.equal(sharing.error.code, 'PUBLIC_SHARE_UNAVAILABLE');
    assert.match(sharing.error.message, /配置导出\/导入/);
    assert.equal((await app.request({ url: `${url}/${created.id}` })).result.shareEnabled, false);
    const updated = (await app.request({ url: `${url}/${created.id}`, method: 'PATCH', data: {
      name: '已修改', id: 999, userId: 'original-account', localOnly: false
    } })).result;
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, '已修改');
    assert.equal(updated.userId, 'local');
    assert.equal(updated.localOnly, true);
    const collection = route === 'field-template' ? 'fieldTemplates' : 'dataFilterTemplates';
    const legacy = app.database.socialLocalBackend[collection].find((item) => item.id === created.id);
    legacy.shareEnabled = true;
    legacy.shareCode = 'legacy-local-reference';
    const disabled = (await app.request({ url: `${url}/${created.id}/share`, method: 'DELETE' })).result;
    assert.equal(disabled.shareEnabled, false);
    assert.equal(disabled.shareCode, null);
    assert.equal((await app.request({ url: `${url}/${created.id}`, method: 'DELETE' })).result.deleted, true);
    assert.equal((await app.request({ url })).result.length, 0);
    assert.equal((await app.request({ url: `${url}/${created.id}` })).error.status, 404);
  }
  const identity = (await app.request({ url: '/ext/user/me' })).result;
  assert.equal(identity.fieldTemplateRevision, 4);
  assert.equal(identity.dataFilterTemplateRevision, 4);
});

test('unsupported remote facilities and unknown routes fail explicitly', async () => {
  const app = harness();
  for (const [url, status, code] of [
    ['/ext/user/script/douyin', 404, 'SCRIPT_UNAVAILABLE'],
    ['/ext/feishu/access_token', 501, 'OWN_FEISHU_CREDENTIALS_REQUIRED'],
    ['/ext/unknown', 404, 'ROUTE_NOT_FOUND']
  ]) {
    const { error } = await app.request({ url });
    assert.equal(error.status, status);
    assert.equal(error.code, code);
  }
  assert.equal((await app.request({ url: '/ext/user/storage', method: 'POST', data: {} })).error.status, 400);
  assert.equal((await app.request({ url: '/ext/user/me', method: 'DELETE' })).error.status, 405);
  const next = (await app.request({ url: '/version/check' })).result;
  assert.equal(next.hasUpdate, false);
  assert.equal(next.latestVersion, '3.6.1');
  assert.deepEqual((await app.request({ url: '/notice/latest' })).result, {});
  assert.equal((await app.request({ url: '/ext/track/active', method: 'POST' })).result.tracked, false);
});

test('reports Chrome callback and Promise storage failures without hanging', async () => {
  for (const promiseStorage of [false, true]) {
    const app = harness({ promiseStorage, storageError: 'Storage disabled' });
    const { error } = await app.request({ url: '/ext/user/storage' });
    assert.equal(error.message, 'Storage disabled');
    assert.equal(error.code, 'LOCAL_STORAGE_ERROR');
  }
});
