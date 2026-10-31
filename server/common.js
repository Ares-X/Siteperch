export class ProviderError extends Error {
  constructor(code, message, status = null, options = {}) {
    super(message, options); this.code = code; this.status = status;
  }
}

// Never expose an upstream URL/body: Bing keys are in the query and token errors may echo credentials.
export async function requestJSON(url, {fetchImpl = globalThis.fetch, method = 'GET', headers = {}, body, timeout = 12000} = {}) {
  let response;
  try {
    response = await fetchImpl(url, {method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeout)});
  } catch (cause) {
    throw new ProviderError('network', '统计服务暂时无法连接，请稍后再试。', null, {cause});
  }
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'authorization' : response.status === 429 ? 'quota' : 'upstream';
    const message = code === 'authorization' ? '授权无效或没有读取权限。' : code === 'quota' ? '接口额度暂时用尽，请等待恢复。' : '统计服务暂时无法返回数据。';
    throw new ProviderError(code, message, response.status);
  }
  try { return await response.json(); }
  catch (cause) { throw new ProviderError('response', '统计服务返回了无法识别的数据。', response.status, {cause}); }
}

export function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}

export function dateAt(now, timeZone = 'UTC') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(now).map(({type,value}) => [type,value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0,10);
}
export function dateRange(days, now = new Date(), timeZone = 'UTC', lagDays = 1) {
  const end = shiftDate(dateAt(now, timeZone), -lagDays);
  return {start: shiftDate(end, 1 - days), end, timeZone};
}
export function unconfigured(id, name, note) { return {id, name, status:'unconfigured', note, fetchedAt:null}; }
export function providerFailure(id, name, error, now = new Date()) {
  return {id, name, status:'error', fetchedAt:now.toISOString(), error:{code:error instanceof ProviderError ? error.code : 'internal', status:error instanceof ProviderError ? error.status : null, message:error instanceof ProviderError ? error.message : '此数据源暂时不可用。'}};
}
