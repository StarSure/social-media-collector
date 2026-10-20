/* Independent local API adapter. Never authenticates with the vendor service. */
globalThis.socialLocalAdapter = async function (config) {
  let data = config.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { /* Preserve literal strings. */ }
  }
  const headers = config.headers?.toJSON?.() || config.headers || {};
  const response = await chrome.runtime.sendMessage({
    type: 'socialLocalRequest',
    data: {
      url: config.url,
      method: config.method || 'GET',
      params: config.params,
      data,
      platform: headers['x-platform'] || globalThis.platform?.code || '',
    },
  });
  if (!response || response.error) {
    const error = new Error(response?.error?.message || '本地服务未响应，请重新加载扩展。');
    error.config = config;
    error.response = { status: response?.error?.status || 500, data: response?.error || {}, config };
    throw error;
  }
  return { data: response.result, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, config };
};
