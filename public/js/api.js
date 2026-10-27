// Same-origin JSON client. Non-GET requests carry the control marker the backend requires.
export async function api(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const headers = {};
  if (method !== 'GET') headers['X-Workflow-Control'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(e?.name === 'TimeoutError' ? '请求超时' : '无法连接服务器');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) throw new Error(data?.error || 'HTTP ' + res.status);
  return data;
}

// Control actions may wait for the current browser operation to finish (backend waits up to ~100 s).
export function control(action) {
  return api('/api/control/' + action, { method: 'POST', timeoutMs: 120000 });
}
