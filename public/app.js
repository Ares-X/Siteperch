const app = document.querySelector('#app');
const demo = new URL(location.href).searchParams.get('demo') === '1';
const titles = { overview: '访问总览', game: '行为事件', search: '搜索表现', sources: '数据源' };
const providers = {
  ga4: { name: 'Google Analytics', symbol: '▥', report: 'https://analytics.google.com/analytics/web/', help: 'https://developers.google.com/analytics/devguides/reporting/data/v1', description: '衡量活跃用户、会话和页面浏览；游戏事件与停留里程碑也来自此处。', setup: '由站点管理员在服务端配置 GA4 Property ID 与具有查看权限的服务账号。' },
  cloudflare: { name: 'Cloudflare', symbol: '☁', report: 'https://dash.cloudflare.com/', help: 'https://developers.cloudflare.com/web-analytics/', description: 'Cloudflare Web Analytics 的访问与页面浏览。访问次数不等于独立访客，也不与 GA4 相加。', setup: '由站点管理员在服务端配置 Cloudflare 只读 API Token 与对应站点标识。' },
  vercel: { name: 'Vercel', symbol: '▲', report: 'https://vercel.com/dashboard', help: 'https://vercel.com/docs/analytics', description: 'Vercel Web Analytics 的独立访客和页面浏览，通过官方统计 API 读取；Hobby 实际权限与额度由账户确认。', setup: '由站点管理员在服务端配置 Vercel 专用凭据与项目；后端仅执行读取；Hobby 实际权限与额度由账户确认。' },
  'search-console': { name: 'Google Search Console', symbol: 'G', report: 'https://search.google.com/search-console', help: 'https://developers.google.com/webmaster-tools/v1/searchanalytics/query', description: 'Google 网页搜索中的点击、展示与平均排名。搜索报表存在延迟和匿名查询省略，不等于站内访问量。', setup: '由站点管理员在服务端配置站点资源，并将只读身份加入 Search Console。' },
  bing: { name: 'Bing Webmaster', symbol: '⊞', report: 'https://www.bing.com/webmasters/', help: 'https://learn.microsoft.com/bingwebmaster/', description: 'Bing 提供的搜索点击与展示；其统计类型与 Google 网页搜索可能不同，请分别阅读。', setup: '由站点管理员在服务端配置 Bing Webmaster 的站点与专用凭据；后端仅执行读取。' },
};
const statusNames = { ok: '已同步', empty: '暂无数据', unconfigured: '待授权', error: '读取失败', stale: '缓存数据' };
const eventNames = { game_ready: '游戏就绪', play_milestone: '航行里程碑', planet_publish: '公开家园', planet_visit: '拜访星球', postcard_share: '分享明信片', postcard_download_requested: '请求下载明信片' };
const paths = { overview: '<path d="M4 18v-5h3v5M10.5 18V9h3v9M17 18V4h3v14"/>', game: '<path d="M7 6h10c3 0 5 11 2 12-1 .4-3-3-4-3H9c-1 0-3 3.4-4 3C2 17 4 6 7 6Z"/><path d="M8 9v5m-2.5-2.5h5M16 10h.1M18 13h.1"/>', search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/>', sources: '<ellipse cx="12" cy="5" rx="8" ry="3.5"/><path d="M4 5v14c0 5 16 5 16 0V5M4 12c0 5 16 5 16 0"/>', lock: '<rect x="6" y="10" width="12" height="11" rx="2"/><path d="M9 10V6a3 3 0 0 1 6 0v4M12 14v3"/>', logout: '<path d="M10 4H4v16h6M10 12h11m-4-4 4 4-4 4"/>', refresh: '<path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 7h.01"/>' };
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.info}</svg>`;
const orbit = '<svg class="orbit" viewBox="0 0 48 48" aria-hidden="true"><ellipse cx="24" cy="24" rx="21" ry="18" transform="rotate(-49 24 24)" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="24" cy="24" r="10" fill="currentColor"/><circle cx="8" cy="38" r="3.3" fill="currentColor"/><circle cx="42" cy="17" r="3" fill="currentColor"/><path d="m39 2 1 7-5-2Z" fill="currentColor"/></svg>';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const number = value => numeric(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value) : '—';
const percent = value => numeric(value) ? `${number(value * 100)}%` : '—';
// A delta needs a positive previous value: zero or missing previous stays blank
// instead of fabricating an infinite or made-up trend.
function delta(data, key) { const current = metric(data, key), previous = data?.comparison?.metrics?.[key]; return numeric(current) && numeric(previous) && previous > 0 ? (current - previous) / previous : null; }
function deltaChip(data, key) { const value = delta(data, key); return value === null ? '' : `<span class="delta ${value < 0 ? 'negative' : 'positive'}">${value < 0 ? '▼' : '▲'} ${number(Math.abs(value) * 100)}%</span>`; }
const timestamp = value => { const date = new Date(value); return value && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚未同步'; };
let tab = Object.hasOwn(titles, location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
let days = 7;
let traffic = 'ga4';
let summary;
let busy = false;
let loadGeneration = 0;
let loggingOut = false;
let loadError = '';
let drawerReturn;
function source(id) { return summary?.sources?.[id] || { id, name: providers[id].name, status: 'unconfigured', metrics: {}, daily: [], pages: [], events: [] }; }
function usable(data) { return data.status === 'ok' || data.status === 'stale'; }
function metric(data, key) { return usable(data) ? data.metrics?.[key] : undefined; }
function sourceStatus(data) { return `<span class="status ${escape(Object.hasOwn(statusNames, data.status) ? data.status : 'error')}">${demo ? (data.status === 'ok' ? '示例连接' : '示例待授权') : escape(statusNames[data.status] || '状态未知')}</span>`; }
function empty(data, context = '统计') { const name = usable(data) ? '暂无数据' : statusNames[data?.status] || '暂无数据'; return `<div class="empty"><strong>${escape(name)}</strong>${data?.status === 'unconfigured' ? '连接数据源后，在这里开始观测。' : data?.status === 'error' ? '暂时无法读取，请查看数据源详情。' : `所选时段暂无可用${escape(context)}。`}<br>${data?.status === 'empty' ? '暂无数据与真实的 0 分开呈现。' : ''}</div>`; }
function rangeText(data) { const range = data.range; return range?.start && range?.end ? `${escape(range.start)} — ${escape(range.end)} · ${escape(range.timeZone || '时区未提供')}` : '日期范围 / 时区尚未提供'; }
function meta(data) { return `<div class="source-meta">${escape(providers[data.id]?.name || data.name || '数据源')} · ${demo ? '示例快照' : `更新于 ${escape(timestamp(data.fetchedAt))}`}<br>${rangeText(data)}</div>`; }
function makeDemo() {
 const now = new Date().toISOString();
 const dates = Array.from({ length: days }, (_, index) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - (days - 1 - index)); return d.toISOString().slice(0, 10); });
 const shift = (date, offset) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
 const comparisonWindow = { start: shift(dates[0], -days), end: shift(dates[0], -1), timeZone: 'Asia/Shanghai' };
 const views = [610, 895, 704, 824, 1068, 890, 996];
 const users = [202, 306, 351, 296, 367, 295, 329];
 const base = id => ({ id, name: providers[id].name, status: 'ok', fetchedAt: now, range: { start: dates[0], end: dates.at(-1), timeZone: 'Asia/Shanghai' }, metrics: {}, daily: [], pages: [], events: [], channels: [], milestones: [] });
 const totalViews = dates.reduce((sum, _, i) => sum + views[i % 7], 0);
 const ga4 = { ...base('ga4'), comparison: { window: comparisonWindow, metrics: { activeUsers: 1140, newUsers: 2, pageViews: Math.round(totalViews / 1.183), sessions: 1477, engagementRate: .699 } }, metrics: { activeUsers: 1284, pageViews: totalViews, sessions: 1620, engagementRate: .684, realtimeUsers: 8 }, daily: dates.map((date, i) => ({ date, pageViews: views[i % 7], activeUsers: users[i % 7] })), pages: [{ path: '/', views: Math.round(totalViews * .712) }, { path: '/about/', views: totalViews - Math.round(totalViews * .712) }], events: [{ name: 'game_ready', count: 932 }, { name: 'play_milestone', count: 1106 }, { name: 'planet_publish', count: 24 }, { name: 'planet_visit', count: 86 }, { name: 'postcard_share', count: 31 }, { name: 'postcard_download_requested', count: 48 }], milestones: [{ seconds: 60, count: 642 }, { seconds: 300, count: 318 }, { seconds: 600, count: 146 }], channels: [{ name: '直接访问', sessions: 804 }, { name: '自然搜索', sessions: 486 }, { name: '引荐', sessions: 330 }] };
 const cfVisits = dates.reduce((sum, _, i) => sum + users[i % 7] + 80, 0), cfViews = totalViews + days * 40;
 const cf = { ...base('cloudflare'), comparison: { window: comparisonWindow, metrics: { visits: Math.round(cfVisits / 1.12), pageViews: Math.round(cfViews / 1.08) } }, metrics: { visits: cfVisits, pageViews: cfViews }, daily: dates.map((date, i) => ({ date, pageViews: views[i % 7] + 40, visits: users[i % 7] + 80 })) };
 const vercel = { ...base('vercel'), comparison: { window: comparisonWindow, metrics: { visitors: 1180, pageViews: Math.round((totalViews + days * 10) / 1.12) } }, metrics: { visitors: 1308, pageViews: totalViews + days * 10 }, daily: dates.map((date, i) => ({ date, pageViews: views[i % 7] + 10, visitors: users[i % 7] + 8 })) };
 return { site: 'example.com', days, generatedAt: now, sources: { ga4, cloudflare: cf, vercel, 'search-console': { ...base('search-console'), status: 'unconfigured' }, bing: { ...base('bing'), status: 'unconfigured' } } };
}
async function request(path, options = {}) {
 const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
 let data; try { data = await response.json(); } catch { data = {}; }
 if (!response.ok) { const error = new Error(data?.error?.message || data?.message || `请求失败（${response.status}）`); error.status = response.status; error.configured = data.configured; throw error; }
 return data;
}
function showLogin(message = '', configured = true) {
 app.innerHTML = `<main class="login-view"><section class="login-card" aria-labelledby="login-title"><div class="brand">${orbit}<span class="brand-name">Siteperch</span><div class="brand-caption">私人观测台</div></div><h1 id="login-title">访问你的观测台</h1><p>在一个地方，了解网站的访问与搜索表现。<br>此处仅向站点所有者开放。</p>${configured ? `<form id="login-form"><label for="owner-password">所有者口令</label><input id="owner-password" name="password" type="password" autocomplete="current-password" required placeholder="输入访问口令" maxlength="1024"><button class="primary-button" type="submit">进入观测台 <span aria-hidden="true">↗</span></button><div id="login-message" class="form-error" role="alert">${escape(message)}</div></form>` : `<div class="drawer-note"><strong>观测台尚未完成配置</strong><p>请站点管理员先配置服务端访问口令与会话签名，再重新打开此页。</p><button class="outline-button" id="retry-session">重新检查</button></div>`}<a class="login-preview" href="?demo=1">查看布局预览 · 示例数据</a><div class="login-foot">${icon('lock')} 私人空间 · 口令不会保存在浏览器</div></section></main>`;
 document.querySelector('#login-form')?.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true; button.textContent = '正在验证…';
  try { await request('/api/login', { method: 'POST', body: JSON.stringify({ password: form.elements.password.value }) }); form.reset(); await load(); }
  catch (error) { if (error.configured === false) { showLogin('', false); return; } document.querySelector('#login-message').textContent = error.status === 401 ? '口令不正确，请重新输入。' : error.status === 429 ? '尝试过于频繁，请稍后再试。' : '暂时无法登录，请稍后重试。'; button.disabled = false; button.textContent = '进入观测台 ↗'; }
 });
 document.querySelector('#retry-session')?.addEventListener('click', initialize);
}
function metricsStrip() {
 // GA4 preferred; fall back to any configured traffic source so the overview stays usable without Google.
 const id = ['ga4', 'vercel', 'cloudflare'].find(candidate => usable(source(candidate))) || 'ga4';
 const data = source(id), provider = providers[id].name;
 const metrics = id === 'ga4' ? [['活跃用户', 'activeUsers', false], ['页面浏览', 'pageViews', false], ['会话数', 'sessions', false], ['互动率', 'engagementRate', true]] : id === 'vercel' ? [['独立访客', 'visitors', false], ['页面浏览', 'pageViews', false]] : [['访问次数', 'visits', false], ['页面浏览', 'pageViews', false]];
 return `<section class="metric-strip" aria-label="${escape(provider)} 核心指标">${metrics.map(([name, key, rate]) => { const chip = deltaChip(data, key); return `<div class="metric"><div class="metric-label">${name}</div><div class="metric-value">${rate ? percent(metric(data, key)) : number(metric(data, key))}</div><div class="metric-foot">${chip ? `${chip} 较上 ${days} 天${demo ? ' · 示例' : ''}` : `${escape(provider)} · ${escape(statusNames[data.status] || '状态未知')}`}</div></div>`; }).join('')}</section>`;
}
function chart(data, series) {
 const reported = usable(data) ? (Array.isArray(data.daily) ? data.daily : []).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date)).slice(0, 90) : [];
 const indexed = new Map(reported.map(row => [row.date, row]));
 const start = data.range?.start, end = data.range?.end;
 const rows = [];
 if (reported.length && /^\d{4}-\d{2}-\d{2}$/.test(start || '') && /^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
  const cursor = new Date(start + 'T00:00:00Z');
  for (let count = 0; cursor.toISOString().slice(0, 10) <= end && count < 90; count++, cursor.setUTCDate(cursor.getUTCDate() + 1)) {
   const date = cursor.toISOString().slice(0, 10); rows.push(indexed.get(date) || { date });
  }
 } else rows.push(...reported);
 if (!rows.length || !series.some(item => rows.some(row => numeric(row[item.key])))) return empty(data, '趋势数据');
 const width = 650, height = 284, left = 45, right = 12, top = 15, bottom = 34;
 const plotW = width - left - right, plotH = height - top - bottom;
 const max = Math.max(1, ...rows.flatMap(row => series.map(s => numeric(row[s.key]) ? row[s.key] : 0)));
 const ceiling = Math.ceil(max / 6 / (10 ** Math.floor(Math.log10(max / 6)))) * (10 ** Math.floor(Math.log10(max / 6))) * 6;
 const x = index => left + plotW * (rows.length === 1 ? .5 : index / (rows.length - 1));
 const y = value => top + plotH * (1 - value / ceiling);
 let svg = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(providers[data.id]?.name || '数据源')} 每日趋势；下方可查看每日数值"><defs><linearGradient id="chart-fill-purple" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6453ff" stop-opacity=".18"/><stop offset="100%" stop-color="#6453ff" stop-opacity=".015"/></linearGradient><linearGradient id="chart-fill-teal" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#14bfbf" stop-opacity=".14"/><stop offset="100%" stop-color="#14bfbf" stop-opacity=".015"/></linearGradient></defs>`;
 for (let i = 0; i <= 6; i++) { const yy = y(ceiling * i / 6); svg += `<line class="chart-grid" x1="${left}" y1="${yy}" x2="${width - right}" y2="${yy}"/><text x="${left - 11}" y="${yy + 4}" text-anchor="end">${number(ceiling * i / 6)}</text>`; }
 const tickEvery = Math.max(1, Math.ceil((rows.length - 1) / 6));
 rows.forEach((row, i) => { if (i % tickEvery === 0 || i === rows.length - 1) svg += `<line class="chart-grid" x1="${x(i)}" y1="${top}" x2="${x(i)}" y2="${height - bottom}"/><text x="${x(i)}" y="${height - 8}" text-anchor="middle">${escape(row.date.slice(5))}</text>`; });
 for (const s of series) {
  const runs = []; let run = [];
  rows.forEach((row, index) => { if (numeric(row[s.key])) run.push({ index, value: row[s.key], date: row.date }); else if (run.length) { runs.push(run); run = []; } }); if (run.length) runs.push(run);
  for (const points of runs) {
   const line = points.map(p => `${x(p.index)},${y(p.value)}`).join(' ');
   svg += `<polygon points="${x(points[0].index)},${height - bottom} ${line} ${x(points.at(-1).index)},${height - bottom}" fill="url(#chart-fill-${s.color})"/><polyline class="chart-line chart-${s.color}" points="${line}"/>`;
   if (rows.length <= 31) for (const p of points) svg += `<circle cx="${x(p.index)}" cy="${y(p.value)}" r="3.5" fill="${s.color === 'purple' ? '#6453ff' : '#14bfbf'}"><title>${escape(p.date)} · ${escape(s.label)} ${number(p.value)}</title></circle>`;
  }
 }
 svg += '</svg>';
 return `${svg}<details class="chart-note"><summary>查看每日数据</summary><div class="table-wrap"><table><thead><tr><th>日期</th>${series.map(s => `<th>${escape(s.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr><td>${escape(row.date)}</td>${series.map(s => `<td>${number(row[s.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}
function trafficCard() {
 const data = source(traffic);
 const series = [{ key: 'pageViews', label: '页面浏览', color: 'purple' }, { key: traffic === 'ga4' ? 'activeUsers' : traffic === 'cloudflare' ? 'visits' : 'visitors', label: traffic === 'ga4' ? '活跃用户' : traffic === 'cloudflare' ? '访问次数' : '独立访客', color: 'teal' }];
 return `<section class="card"><div class="card-header"><h2>访问趋势</h2><div class="legend">${series.map(s => `<span><i class="dot ${s.color === 'teal' ? 'teal' : ''}"></i>${s.label}</span>`).join('')}</div><div class="chart-controls"><label class="small" for="traffic-source">统计来源</label><select id="traffic-source">${['ga4', 'vercel', 'cloudflare'].map(id => `<option value="${id}" ${traffic === id ? 'selected' : ''}>${providers[id].name}</option>`).join('')}</select><span class="small">${traffic === 'cloudflare' ? '访问次数 ≠ 独立访客' : '不同平台分别统计'}</span></div></div>${chart(data, series)}<p class="chart-note">${rangeText(data)} · 含今日，今日数据仍在变化${data.status === 'stale' ? ' · 当前显示缓存，最近读取失败' : ''}</p></section>`;
}
function connectionCard() { return `<section class="card"><div class="card-header"><h2>数据连接</h2><button class="text-button" data-nav="sources">管理 <span aria-hidden="true">↗</span></button></div><div class="connection-list">${Object.keys(providers).map(id => `<button class="connection" data-source="${id}" aria-label="${escape(providers[id].name)}：${escape(demo ? '示例状态' : statusNames[source(id).status])}，查看详情"><span class="source-symbol ${id}" aria-hidden="true">${providers[id].symbol}</span><span class="source-name">${providers[id].name}</span>${sourceStatus(source(id))}<span class="chevron" aria-hidden="true">›</span></button>`).join('')}</div></section>`; }
function pagesCard(data = source('ga4')) {
 const rows = usable(data) && Array.isArray(data.pages) ? data.pages.slice(0, 10) : [];
 return `<section class="card"><div class="card-header"><h2>热门页面</h2><span class="small">${escape(providers[data.id]?.name || 'GA4')}</span></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>页面</th><th>浏览量</th><th>占比</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(row.path)}</td><td>${number(row.views)}</td><td>${numeric(row.views) && numeric(data.metrics?.pageViews) && data.metrics.pageViews > 0 ? percent(row.views / data.metrics.pageViews) : '—'}</td></tr>`).join('')}</tbody></table></div>` : empty(data, '页面数据')}</section>`;
}
function eventRows(data, full = false) {
 const events = usable(data) && Array.isArray(data.events) ? data.events.filter(event => Object.hasOwn(eventNames, event.name)) : [];
 const milestones = usable(data) && Array.isArray(data.milestones) ? data.milestones : [];
 const eventRow = event => ({ name: eventNames[event.name], count: event.count });
 const rows = [
  ...events.filter(event => event.name === 'game_ready').map(eventRow),
  ...milestones.map(event => ({ name: `航行${number(event.seconds / 60)}分钟`, count: event.count })),
  ...events.filter(event => event.name !== 'game_ready' && (event.name !== 'play_milestone' || !milestones.length)).map(eventRow),
 ];
 const selected = rows.slice(0, full ? 30 : 5);
 const maximum = Math.max(1, ...selected.map(row => numeric(row.count) ? row.count : 0));
 return selected.length ? `<div class="events">${selected.map(row => `<div class="event-row"><span>${escape(row.name)}</span><svg class="bar-svg" viewBox="0 0 260 14" preserveAspectRatio="none" aria-hidden="true"><rect width="260" height="14" rx="3" fill="#f0f2f8"/><rect width="${numeric(row.count) ? Math.max(0, row.count) / maximum * 232 : 0}" height="14" rx="3" fill="#6453ff"/></svg><span>${number(row.count)}</span></div>`).join('')}</div>` : empty(data, '事件数据');
}
function eventsCard(full = false) { return `<section class="card"><div class="card-header"><h2>${full ? '事件与航行里程碑' : '游戏事件'}</h2><span class="small">事件次数，不等于独立玩家</span></div>${eventRows(source('ga4'), full)}</section>`; }
function overview() { return `${metricsStrip()}<div class="dashboard-grid">${trafficCard()}${connectionCard()}</div><div class="lower-grid">${pagesCard()}${eventsCard()}</div>`; }
function gameView() {
 const data = source('ga4'); const rows = usable(data) && Array.isArray(data.channels) ? data.channels : [];
 return `<p class="section-intro">了解网站的使用与停留情况。这里记录 GA4 收到的真实行为事件；航行时长里程碑不是留存率或转化漏斗。</p>${metricsStrip()}<div class="lower-grid">${eventsCard(true)}<section class="card"><div class="card-header"><h2>访客从哪里来</h2><span class="small">GA4 · 会话来源</span></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>来源渠道</th><th>会话数</th></tr></thead><tbody>${rows.slice(0, 20).map(row => `<tr><td>${escape(row.name)}</td><td>${number(row.sessions)}</td></tr>`).join('')}</tbody></table></div>` : empty(data, '来源数据')}</section></div><p class="section-intro section-spaced">口径说明：同一位旅人可以多次触发事件。里程碑只表示收到对应时长事件；未上报、拦截或离线行为可能不在其中。${rangeText(data)}</p>`;
}
// Each table displays only fields returned by its provider, without reconstructing totals.
function dataTable(rows, columns, title) {
 const available = columns.filter((column, index) => index === 0 || rows.some(row => row[column.key] !== undefined && row[column.key] !== null));
 return `<div class="table-wrap"><table><caption class="sr-only">${escape(title)}</caption><thead><tr>${available.map(column => `<th scope="col">${escape(column.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${available.map(column => `<td>${column.format ? column.format(row[column.key]) : escape(row[column.key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function detailTable(data, key, title, columns, errorKeys = [key]) {
 if (!usable(data) && data.status !== 'empty') return '';
 const rows = Array.isArray(data[key]) ? data[key] : [];
 const error = errorKeys.map(errorKey => data.metadata?.optionalErrors?.[errorKey]).find(Boolean);
 const state = error ? '读取失败' : rows.length ? `${number(rows.length)} 行` : data[key] == null ? '未提供' : '暂无数据';
 return `<details class="dimension-details"><summary>${escape(title)}<span>${state}</span></summary>${error ? '<p class="small">此明细读取失败或超出当前查询能力，请使用官方报表核对；其余可用数据仍分别展示。</p>' : ''}${rows.length ? dataTable(rows, columns, title) : '<p class="small">未返回可用明细，不代表真实流量为零。</p>'}</details>`;
}
const trafficColumns = [
 {key:'views',label:'浏览量',format:number}, {key:'visitors',label:'独立访客',format:number},
 {key:'visits',label:'访问次数',format:number}, {key:'sessions',label:'会话数',format:number},
];
const searchColumns = [
 {key:'clicks',label:'点击',format:number}, {key:'impressions',label:'展示',format:number},
 {key:'ctr',label:'点击率',format:percent}, {key:'position',label:'平均排名',format:number},
];
function sourceTotals(data) {
 const metrics = data.id === 'ga4' ? [
  ['活跃用户','activeUsers'], ['页面浏览','pageViews'], ['会话数','sessions'], ['互动率','engagementRate'],
  ...(numeric(metric(data,'newUsers')) ? [['新用户','newUsers']] : []),
 ] : data.id === 'cloudflare' ? [['访问次数','visits'],['页面浏览','pageViews']]
  : data.id === 'vercel' ? [['独立访客','visitors'],['页面浏览','pageViews']]
  : [['点击','clicks'],['展示','impressions'],['点击率','ctr'],['平均排名','position']];
 return `<dl class="source-totals" aria-label="${escape(providers[data.id].name)} 期间汇总">${metrics.map(([label,key]) => { const chip = deltaChip(data,key); return `<div><dt>${label}</dt><dd>${['engagementRate','ctr'].includes(key) ? percent(metric(data,key)) : number(metric(data,key))}${chip ? ` ${chip}` : ''}</dd></div>`; }).join('')}</dl>`;
}
function trafficDetails(data) {
 const id = data.id;
 return detailTable(data,'daily','每日数据',[
  {key:'date',label:'日期'}, {key:'activeUsers',label:'活跃用户',format:number},
  {key:'pageViews',label:'页面浏览',format:number}, {key:'visitors',label:'独立访客',format:number}, {key:'visits',label:'访问次数',format:number},
 ],id === 'vercel' ? ['day'] : ['daily'])
 + detailTable(data,'pages','页面明细',[{key:'path',label:'页面'},...trafficColumns],id === 'vercel' ? ['requestPath'] : ['pages'])
 + detailTable(data,'channels','来源明细',[{key:'name',label:'来源'},...trafficColumns],id === 'vercel' ? ['referrerHostname'] : ['channels'])
 + detailTable(data,'countries','国家与地区',[{key:'name',label:'国家 / 地区'},...trafficColumns],id === 'vercel' ? ['country'] : ['countries'])
 + detailTable(data,'devices','设备明细',[{key:'name',label:'设备'},...trafficColumns],id === 'vercel' ? ['deviceType'] : ['devices']);
}
function searchDetails(data) {
 const bing = data.id === 'bing';
 return detailTable(data,'daily','每日搜索数据',[{key:'date',label:'日期'},...searchColumns],bing ? ['GetRankAndTrafficStats'] : ['daily'])
 + detailTable(data,'pages','热门搜索页面',[{key:'path',label:'页面'},...searchColumns],bing ? ['GetPageStats'] : ['pages'])
 + detailTable(data,'sitemaps','站点地图',[
  {key:'path',label:'站点地图'}, {key:'status',label:'状态'}, {key:'type',label:'类型'},
  {key:'isPending',label:'等待处理',format:value => value === true ? '是' : value === false ? '否' : '—'},
  {key:'lastSubmitted',label:'最近提交'}, {key:'lastDownloaded',label:'最近读取'},
  {key:'urlCount',label:'网址数',format:number}, {key:'warnings',label:'警告',format:number}, {key:'errors',label:'错误',format:number},
 ],bing ? ['GetFeeds'] : ['sitemaps']);
}
function searchCard(id) {
 const data = source(id); const queries = usable(data) && Array.isArray(data.queries) ? data.queries : [];
 return `<section class="card source-card"><div class="card-header"><div class="source-detail-title"><span class="source-symbol ${id}" aria-hidden="true">${providers[id].symbol}</span><h2>${id === 'bing' ? 'Bing 搜索' : 'Google 网页搜索'}</h2></div>${sourceStatus(data)}</div><p>${escape(providers[id].description)}</p><div class="search-metrics">${[['点击', 'clicks'], ['展示', 'impressions'], ['点击率', 'ctr'], ['平均排名', 'position']].map(([label, key]) => { const chip = deltaChip(data, key); return `<div><span class="small">${label}</span><span class="value">${key === 'ctr' ? percent(metric(data, key)) : number(metric(data, key))}</span>${chip ? `<span class="small">${chip} 较上期</span>` : ''}</div>`; }).join('')}</div>${queries.length ? dataTable(queries, [{key:'query',label:'搜索词'},...searchColumns], '热门搜索词') : empty(data, '搜索词数据')}${searchDetails(data)}${meta(data)}<button class="outline-button" data-source="${id}">查看数据源详情 ↗</button></section>`;
}
function searchView() { return `<p class="section-intro">查看访客通过搜索发现网站的情况。Google 网页搜索和 Bing 按各自口径展示，点击量不合并。</p><div class="source-grid">${searchCard('search-console')}${searchCard('bing')}</div>`; }
function sourceView() { return `<p class="section-intro">五个数据源，分别观察同一个网站。数据由服务端读取，凭据只留在服务端；免费额度受限时，其余观测仍然可用。</p><div class="source-grid">${Object.keys(providers).map(id => { const data = source(id); return `<section class="card source-card"><div class="card-header"><div class="source-detail-title"><span class="source-symbol ${id}" aria-hidden="true">${providers[id].symbol}</span><h2>${providers[id].name}</h2></div>${sourceStatus(data)}</div><p>${escape(providers[id].description)}</p>${data.note ? `<p>${escape(data.note)}</p>` : ''}${data.error?.message ? `<p>最近读取：${escape(data.error.message)}</p>` : ''}${sourceTotals(data)}${['ga4','cloudflare','vercel'].includes(id) ? trafficDetails(data) : searchDetails(data)}${meta(data)}<button class="outline-button" data-source="${id}">连接与口径说明 ↗</button></section>`; }).join('')}</div>`; }
function render() {
 app.innerHTML = `<a class="skip-link" href="#main-content">跳至主要内容</a><aside class="sidebar"><div class="brand">${orbit}<span class="brand-name">Siteperch</span><div class="brand-caption">观测台</div></div><nav class="nav" aria-label="观测台导航">${Object.entries(titles).map(([key, title]) => `<button data-nav="${key}" class="${tab === key ? 'active' : ''}" ${tab === key ? 'aria-current="page"' : ''}>${icon(key)}${title}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="private-label">${icon('lock')} 仅自己可见</div><button class="logout" id="logout">${icon('logout')} ${demo ? '退出预览' : '退出'}</button></div></aside><main class="workspace" id="main-content" tabindex="-1"><header class="page-header"><div><h1>${titles[tab]}</h1><div class="subtitle">${escape(summary?.site || '未配置站点')}</div></div><div class="header-actions"><div class="range-control" role="group" aria-label="日期范围">${[7, 28].map(range => `<button data-days="${range}" class="${days === range ? 'selected' : ''}" aria-pressed="${days === range}" ${busy ? 'disabled' : ''}>近 ${range} 天</button>`).join('')}</div><button class="outline-button" id="refresh" ${busy ? 'disabled' : ''}>${icon('refresh')} ${busy ? '同步中' : '刷新'}</button></div></header>${demo ? `<div class="banner" role="note">${icon('info')}<strong>布局预览 · 示例数据</strong><span>本页所有数据均为示例，仅用于界面布局与功能演示，不代表真实业务数据。</span><button class="leave-demo" id="leave-demo">查看真实数据 ↗</button></div>` : ''}${loadError ? `<div class="banner notice" role="alert">${icon('info')}<span>${escape(loadError)}</span></div>` : ''}<div id="content" aria-busy="${busy}">${tab === 'overview' ? overview() : tab === 'game' ? gameView() : tab === 'search' ? searchView() : sourceView()}</div><footer class="footer"><span>${demo ? '布局预览 · 所有数字均为示例' : `快照生成于 ${escape(timestamp(summary?.generatedAt))} · 结果缓存最多 5 分钟`}</span><span>GA4 · ${escape(source('ga4').range?.timeZone || '时区未提供')} · ${numeric(metric(source('ga4'), 'realtimeUsers')) ? `近 30 分钟 ${number(metric(source('ga4'), 'realtimeUsers'))} 位活跃用户` : '近 30 分钟活跃人数未提供'}</span></footer><div class="sr-only" role="status" id="sync-status">${busy ? '正在同步所选日期范围的数据' : '页面已更新'}</div></main>`;
 bind();
}
function bind() {
 app.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.nav)));
 app.querySelectorAll('[data-days]').forEach(button => button.addEventListener('click', () => { days = Number(button.dataset.days); load(); }));
 app.querySelectorAll('[data-source]').forEach(button => button.addEventListener('click', () => showSource(button.dataset.source, button)));
 document.querySelector('#traffic-source')?.addEventListener('change', event => { traffic = event.target.value; render(); document.querySelector('#traffic-source')?.focus(); });
 document.querySelector('#refresh')?.addEventListener('click', () => load());
 document.querySelector('#leave-demo')?.addEventListener('click', leaveDemo);
 document.querySelector('#logout')?.addEventListener('click', async event => {
  if (demo) { leaveDemo(); return; }
  if (loggingOut) return;
  loggingOut = true;
  ++loadGeneration; // A response authorized before logout must never restore the dashboard.
  busy = false;
  event.currentTarget.disabled = true;
  try { await request('/api/logout', { method: 'POST' }); summary = undefined; showLogin(); }
  catch { loadError = '暂时无法退出，请稍后重试。'; render(); }
  finally { loggingOut = false; }
 });
}
function navigate(next) { if (!Object.hasOwn(titles, next)) return; tab = next; history.replaceState(null, '', `${location.pathname}${location.search}#${next}`); render(); document.querySelector('#main-content').focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }
function leaveDemo() { const url = new URL(location.href); url.searchParams.delete('demo'); location.assign(url.href); }
// GA4 reports its own token quota alongside each report; show what the backend already fetched.
// The Data API serializes these int64 counters as strings, so parse before the strict numeric helpers.
function quotaRows(data) {
 const quota = data?.metadata?.propertyQuota;
 if (!quota || typeof quota !== 'object') return '';
 const finite = value => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
 const cells = [['tokensPerHour', '近 1 小时'], ['tokensPerDay', '近 24 小时']].map(([key, label]) => {
  const consumed = finite(quota[key]?.consumed), remaining = finite(quota[key]?.remaining);
  if (consumed === null || remaining === null) return '';
  return `<dd>${label}已用 ${number(consumed)} · 剩余 ${number(remaining)} tokens</dd>`;
 }).join('');
 return cells ? `<dt>GA4 配额</dt>${cells}` : '';
}
function comparisonRow(data) {
 const period = data?.comparison?.window;
 return period?.start && period?.end ? `<dt>环比参考期</dt><dd>${escape(period.start)} — ${escape(period.end)} · ${escape(period.timeZone || '时区未提供')}；上期缺失或为零的指标不显示涨跌</dd>` : '';
}
function showSource(id, returnTarget) {
 if (!Object.hasOwn(providers, id)) return;
 const provider = providers[id], data = source(id); drawerReturn = returnTarget;
 const overlay = document.createElement('div'); overlay.className = 'modal-backdrop';
 overlay.innerHTML = `<section class="drawer" role="dialog" aria-modal="true" aria-labelledby="source-title"><div class="drawer-header"><h2 id="source-title">${provider.name}</h2><button class="close-button" aria-label="关闭详情">✕</button></div>${sourceStatus(data)}<p>${escape(provider.description)}</p>${demo ? '<p class="drawer-note">这是布局预览。此处没有验证任何真实连接，也不会请求统计 API。</p>' : ''}<dl><dt>当前数据范围</dt><dd>${rangeText(data)}</dd>${comparisonRow(data)}<dt>最近同步</dt><dd>${escape(timestamp(data.fetchedAt))}${data.status === 'stale' ? ' · 缓存快照，最近读取失败' : ''}</dd>${quotaRows(data)}<dt>连接说明</dt><dd>${escape(provider.setup)}</dd>${data.note ? `<dt>数据说明</dt><dd>${escape(data.note)}</dd>` : ''}${data.error ? `<dt>读取信息</dt><dd>${escape(data.error.message || '暂时无法读取')}${data.error.code ? `（${escape(data.error.code)}）` : ''}</dd>` : ''}</dl><p class="drawer-note">${id === 'ga4' ? '活跃用户、会话和事件各有自己的去重规则，不宜相互替代。未提供上期对比时不会显示涨跌幅。' : id === 'cloudflare' ? '访问次数和页面浏览保持 Cloudflare 原始口径，不推算独立用户。' : id === 'vercel' ? '通过 Vercel 官方统计 API 读取；Hobby 实际权限与额度由账户确认。' : '搜索查询可能被匿名化或省略。可见查询合计不一定等于报表总数。'}<br>不同平台的数据不会相加。缺失数据保持为空。</p><a href="${escape(provider.report)}" target="_blank" rel="noopener noreferrer">打开官方报表 <span aria-hidden="true">↗</span></a><a href="${escape(provider.help)}" target="_blank" rel="noopener noreferrer">阅读官方数据说明 <span aria-hidden="true">↗</span></a></section>`;
 document.body.append(overlay); const closeButton = overlay.querySelector('button'); closeButton.focus();
 const close = () => { overlay.remove(); document.removeEventListener('keydown', keydown); drawerReturn?.focus(); };
 const keydown = event => { if (event.key === 'Escape') { event.preventDefault(); close(); } if (event.key === 'Tab') { const nodes = [...overlay.querySelectorAll('button,a[href]')]; const first = nodes[0], last = nodes.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } };
 closeButton.addEventListener('click', close); overlay.addEventListener('click', event => { if (event.target === overlay) close(); }); document.addEventListener('keydown', keydown);
}
async function load() {
 if (busy || loggingOut) return;
 const generation = ++loadGeneration;
 const focused = document.activeElement;
 const restoreFocus = focused?.id === 'refresh' ? '#refresh' : focused?.dataset?.days ? `[data-days="${days}"]` : null;
 busy = true; loadError = ''; render();
 try {
  const result = demo ? makeDemo() : await request(`/api/summary?days=${days}`);
  if (generation !== loadGeneration) return;
  summary = result;
 }
 catch (error) { if (generation !== loadGeneration) return; if (error.status === 401) { busy = false; summary = undefined; showLogin(); return; } if (error.configured === false) { busy = false; showLogin('', false); return; } if (summary?.days) days = summary.days; loadError = summary ? '刷新失败，仍显示上一次成功读取的快照。请稍后重试；数据时间见下方。' : '暂时无法读取数据。请稍后刷新，或查看各数据源的连接说明。'; }
 finally { if (generation === loadGeneration) busy = false; }
 if (generation !== loadGeneration) return;
 render();
 if (restoreFocus) document.querySelector(restoreFocus)?.focus();
}
async function initialize() {
 if (demo) { await load(); return; }
 try { const session = await request('/api/session'); if (session.configured === false) { showLogin('', false); return; } if (!session.authenticated) { showLogin(); return; } await load(); }
 catch (error) { showLogin('无法检查登录状态，请稍后重试。', error.configured !== false); }
}
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); if (Object.hasOwn(titles, next) && next !== tab) { tab = next; if (summary) render(); } });
initialize();
