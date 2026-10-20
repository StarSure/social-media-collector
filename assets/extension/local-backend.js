/* Standalone local identity and persistence. This is not an original-service
 * account, subscription, token, or cloud sync. isVip/hasAnyVip only preserve the
 * shipped UI's local feature switches; no original-service credentials are used.
 */
(function () {
  'use strict';
  const STORE_KEY = 'socialLocalBackend';
  let queue = Promise.resolve();

  function fail(status, message, code) {
    const error = new Error(message);
    error.status = status;
    error.code = code || 'LOCAL_REQUEST_ERROR';
    throw error;
  }

  function storage(method, value) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      };
      try {
        const result = chrome.storage.local[method](value, finish);
        if (result && typeof result.then === 'function') {
          result.then(finish, (error) => {
            if (!settled) { settled = true; reject(error); }
          });
        }
      } catch (error) { reject(error); }
    });
  }

  function newState() {
    return {
      schemaVersion: 1, nextId: 1, storage: [], fieldTemplates: [],
      dataFilterTemplates: [], fieldTemplateRevision: 0,
      dataFilterTemplateRevision: 0, storageUpdateAt: 0
    };
  }

  function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  async function handle(request) {
    if (!object(request) || typeof request.url !== 'string') {
      fail(400, '本地请求缺少 url', 'INVALID_REQUEST');
    }
    const url = new URL(request.url, 'https://local.invalid');
    // Routes are local regardless of a supplied URL. Never issue a network call.
    const path = url.pathname.replace(/\/$/, '') || '/';
    const method = (request.method || 'GET').toUpperCase();
    const params = { ...Object.fromEntries(url.searchParams), ...(request.params || {}) };
    const body = request.data;
    const saved = await storage('get', STORE_KEY);
    const state = { ...newState(), ...(saved && saved[STORE_KEY]) };
    const persist = () => storage('set', { [STORE_KEY]: state });
    const requireMethod = (...methods) => {
      if (!methods.includes(method)) fail(405, `本地路由不支持 ${method}`, 'METHOD_NOT_ALLOWED');
    };
    const identity = () => ({
      id: 'local', name: '本地用户', email: 'local@localhost',
      platform: request.platform || params.platform || 'all',
      isVip: true, hasAnyVip: true, localOnly: true,
      accountType: 'local', cloudSyncEnabled: false,
      fieldTemplateRevision: state.fieldTemplateRevision,
      dataFilterTemplateRevision: state.dataFilterTemplateRevision,
      storageUpdateAt: state.storageUpdateAt
    });

    if (path === '/ext/user/me') { requireMethod('GET'); return identity(); }
    if (path === '/ext/user/vip/status') {
      requireMethod('GET');
      // The account screen consumes an array of original-service subscriptions.
      // A local identity has none, independently of its local UI feature flags.
      return [];
    }
    if (/^\/ext\/auth\/(login|logout|refresh_token)$/.test(path)) {
      requireMethod('POST');
      return { localOnly: true, accountType: 'local', authenticated: false,
        message: '本地身份无需登录；未登录原服务，未生成访问令牌' };
    }
    if (path === '/ext/user/storage') {
      requireMethod('GET', 'POST');
      if (method === 'GET') {
        const from = Number(params.updatedAtFrom || 0);
        if (!Number.isFinite(from)) fail(400, 'updatedAtFrom 必须是时间戳');
        return state.storage.filter((item) => item.updatedAt > from);
      }
      if (!object(body) || typeof body.key !== 'string' || !body.key) {
        fail(400, '存储记录需要非空 key', 'INVALID_STORAGE_RECORD');
      }
      const now = Math.max(Date.now(), state.storageUpdateAt + 1);
      const record = { key: body.key, value: body.value, version: body.version ?? 1,
        modifiedAt: body.modifiedAt ?? now, updatedAt: now };
      const index = state.storage.findIndex((item) => item.key === record.key);
      if (index < 0) state.storage.push(record);
      else state.storage[index] = record;
      state.storageUpdateAt = now;
      await persist();
      return record;
    }

    const template = path.match(/^\/ext\/user\/(field-template|data-filter-template)(?:\/(\d+)(?:\/(share))?)?$/);
    if (template) {
      const collection = template[1] === 'field-template' ? 'fieldTemplates' : 'dataFilterTemplates';
      const revision = template[1] === 'field-template' ? 'fieldTemplateRevision' : 'dataFilterTemplateRevision';
      const records = state[collection];
      const id = template[2] ? Number(template[2]) : null;
      if (id === null) {
        requireMethod('GET', 'POST');
        if (method === 'GET') {
          return records.filter((item) =>
            (params.platform === undefined || item.platform === params.platform) &&
            (params.type === undefined || item.type === params.type));
        }
        if (!object(body)) fail(400, '模板内容必须是对象', 'INVALID_TEMPLATE');
        const now = Date.now();
        const record = { ...body, id: state.nextId++, userId: 'local',
          shareEnabled: false, shareCode: null, localOnly: true,
          createdAt: now, updatedAt: now };
        records.push(record);
        state[revision]++;
        await persist();
        return record;
      }
      const index = records.findIndex((item) => item.id === id);
      if (index < 0) fail(404, '本地模板不存在', 'TEMPLATE_NOT_FOUND');
      const record = records[index];
      if (template[3] === 'share') {
        requireMethod('POST', 'DELETE');
        if (method === 'POST') {
          fail(501, '离线版本不提供公网模板分享；请使用设置中的配置导出/导入', 'PUBLIC_SHARE_UNAVAILABLE');
        }
        record.shareEnabled = false;
        record.shareCode = null;
      } else {
        requireMethod('GET', 'PATCH', 'PUT', 'DELETE');
        if (method === 'GET') return record;
        if (method === 'DELETE') records.splice(index, 1);
        else {
          if (!object(body)) fail(400, '模板内容必须是对象', 'INVALID_TEMPLATE');
          const { id: ignoredId, userId, shareEnabled, shareCode, localOnly,
            createdAt, ...changes } = body;
          Object.assign(record, changes);
        }
      }
      record.updatedAt = Date.now();
      state[revision]++;
      await persist();
      return method === 'DELETE' && !template[3] ? { id, deleted: true } : record;
    }
    if (path === '/version/check' || path === '/version/latest') {
      requireMethod('GET');
      const version = chrome.runtime.getManifest().version;
      return { version, currentVersion: version, latestVersion: version,
        hasUpdate: false, localOnly: true, changelog: '独立本地运行版本' };
    }
    if (path === '/notice/latest') { requireMethod('GET'); return {}; }
    if (path === '/ext/track/active') {
      requireMethod('POST');
      return { localOnly: true, tracked: false };
    }
    if (/^\/ext\/user\/script\/[^/]+$/.test(path)) {
      fail(404, '原服务动态脚本不可用；本地版本仅运行已重建并验证的采集器', 'SCRIPT_UNAVAILABLE');
    }
    if (path === '/ext/feishu/access_token') {
      fail(501, '本地版本不提供原服务飞书令牌；请配置您自己的飞书 App ID 和 App Secret', 'OWN_FEISHU_CREDENTIALS_REQUIRED');
    }
    fail(404, `本地版本未实现路由：${path}`, 'ROUTE_NOT_FOUND');
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'socialLocalRequest') return;
    // Serialize reads as well as writes so a following read sees completed saves.
    const operation = queue.then(() => handle(message.data));
    queue = operation.catch(() => {});
    operation.then((result) => sendResponse({ result }), (error) => sendResponse({
      error: { message: error.message || String(error), status: error.status || 500,
        code: error.code || 'LOCAL_STORAGE_ERROR' }
    }));
    return true;
  });
})();
