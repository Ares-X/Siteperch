import {ProviderError, requestJSON, numeric, dateRange, shiftDate, unconfigured, providerFailure} from '../common.js';

const SCOPES = 'https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly';
const tokenCache = new Map();
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const encode = value => base64url(new TextEncoder().encode(JSON.stringify(value)));
const safeError = error => ({code:error instanceof ProviderError ? error.code : 'internal', status:error instanceof ProviderError ? error.status : null});

async function accessToken(config, fetchImpl) {
  const oauth = config.googleClientId && config.googleClientSecret && config.googleRefreshToken;
  const credentials = oauth ? JSON.stringify([config.googleClientId,config.googleClientSecret,config.googleRefreshToken]) : config.googleServiceAccount;
  const key = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credentials))));
  const cached = tokenCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.token;
  let body;
  if (oauth) {
    body = new URLSearchParams({grant_type:'refresh_token', client_id:config.googleClientId, client_secret:config.googleClientSecret, refresh_token:config.googleRefreshToken});
  } else {
    let account;
    try {
      account = JSON.parse(config.googleServiceAccount);
      if (!account.client_email || !account.private_key) throw new Error('missing fields');
      const pem = account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
      const privateKey = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), char => char.charCodeAt(0)), {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'}, false, ['sign']);
      const issued = Math.floor(Date.now()/1000);
      const unsigned = `${encode({alg:'RS256',typ:'JWT'})}.${encode({iss:account.client_email,scope:SCOPES,aud:'https://oauth2.googleapis.com/token',iat:issued,exp:issued+3600})}`;
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(unsigned));
      body = new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${unsigned}.${base64url(new Uint8Array(signature))}`});
    } catch (cause) { throw new ProviderError('configuration','Google 服务账号配置无法读取。',null,{cause}); }
  }
  const response = await requestJSON('https://oauth2.googleapis.com/token', {fetchImpl,method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()});
  if (typeof response.access_token !== 'string' || !response.access_token) throw new ProviderError('response','Google 未返回有效授权。');
  const ttl = Math.min(3600, Math.max(0,numeric(response.expires_in) ?? 0));
  if (tokenCache.size > 20) tokenCache.clear();
  tokenCache.set(key,{token:response.access_token,expires:Date.now()+Math.max(0,ttl-60)*1000});
  return response.access_token;
}

function reportRows(report) {
  if (!report || !Array.isArray(report.metricHeaders)) throw new ProviderError('response','Google 返回的报表结构不完整。');
  return (report.rows || []).map(row => ({
    dimensions:Object.fromEntries((report.dimensionHeaders || []).map((header,index) => [header.name,row.dimensionValues?.[index]?.value ?? ''])),
    metrics:Object.fromEntries(report.metricHeaders.map((header,index) => [header.name,numeric(row.metricValues?.[index]?.value)])),
  }));
}
function realtimeUserCount(report) {
  const emptyRows = report?.rows === undefined || (Array.isArray(report.rows) && report.rows.length === 0);
  const emptyCount = report?.rowCount === undefined || report.rowCount === 0;
  // Observed official empty realtime response contains only kind and quota, without headers.
  if (report?.kind === 'analyticsData#runRealtimeReport' && report.metricHeaders === undefined && report.dimensionHeaders === undefined && emptyRows && emptyCount) return 0;
  if (!Array.isArray(report?.metricHeaders) || report.metricHeaders.length !== 1 || report.metricHeaders[0]?.name !== 'activeUsers' || (!emptyCount && emptyRows) || (report.rows !== undefined && !Array.isArray(report.rows))) {
    throw new ProviderError('response','Google 返回的实时报表结构不完整。');
  }
  const rows = reportRows(report);
  if (!rows.length) return 0;
  const count = rows[0].metrics.activeUsers;
  if (count === null) throw new ProviderError('response','Google 返回的实时人数无法读取。');
  return count;
}
const gaURL = id => `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(id)}`;
const gaMetricNames = ['activeUsers','newUsers','sessions','screenPageViews','engagementRate'];
// With two dateRanges GA4 stamps each row with a dateRangeIndex dimension; without
// it every row belongs to the requested single range.
const totalsRow = (report,index) => reportRows(report).find(row => (row.dimensions.dateRangeIndex ?? String(index)) === String(index));
const metricsFrom = row => Object.fromEntries(gaMetricNames.map(name => [name === 'screenPageViews' ? 'pageViews' : name,row?.metrics[name] ?? null]));

async function readGA(config, token, options) {
  const {days,now,fetchImpl} = options;
  const post = (suffix,body) => requestJSON(`${gaURL(config.gaPropertyId)}:${suffix}`,{fetchImpl,method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const ranges = [{startDate:`${days-1}daysAgo`,endDate:'today'}];
  const report = (dimensions,metrics,extra={}) => ({dateRanges:ranges,dimensions:dimensions.map(name=>({name})),metrics:metrics.map(name=>({name})),returnPropertyQuota:true,...extra});
  const requests = [
    // The comparison period rides in the same batch call: one extra dateRange
    // instead of one extra request, so period deltas cost no extra quota.
    report([],gaMetricNames,{dateRanges:[...ranges,{startDate:`${2*days-1}daysAgo`,endDate:`${days}daysAgo`}]}),
    report(['date'],['activeUsers','screenPageViews'],{orderBys:[{dimension:{dimensionName:'date'}}],limit:'28'}),
    report(['pagePath'],['screenPageViews'],{orderBys:[{metric:{metricName:'screenPageViews'},desc:true}],limit:'10'}),
    report(['sessionDefaultChannelGroup'],['sessions'],{orderBys:[{metric:{metricName:'sessions'},desc:true}],limit:'10'}),
    report(['eventName'],['eventCount'],{orderBys:[{metric:{metricName:'eventCount'},desc:true}],limit:'100'}),
  ];
  const [core,realtime,milestones] = await Promise.allSettled([
    post('batchRunReports',{requests}),
    post('runRealtimeReport',{metrics:[{name:'activeUsers'}],returnPropertyQuota:true}),
    post('runReport',report(['customEvent:threshold_seconds'],['eventCount'],{dimensionFilter:{filter:{fieldName:'eventName',stringFilter:{matchType:'EXACT',value:'play_milestone'}}},limit:'100'})),
  ]);
  if (core.status === 'rejected') throw core.reason;
  const reports = core.value.reports;
  if (!Array.isArray(reports) || reports.length !== 5) throw new ProviderError('response','Google 返回的报表结构不完整。');
  const [total,daily,pages,channels,events] = reports;
  const metrics = metricsFrom(totalsRow(total,0));
  const optionalErrors = {};
  let realtimeUsers = null, milestoneRows = [];
  for (const [key,result] of [['realtime',realtime],['milestones',milestones]]) {
    try {
      if (result.status === 'rejected') throw result.reason;
      if (key === 'realtime') realtimeUsers = realtimeUserCount(result.value);
      else milestoneRows = reportRows(result.value);
    } catch (error) { optionalErrors[key] = safeError(error); }
  }
  metrics.realtimeUsers = realtimeUsers;
  const timeZone = total.metadata?.timeZone || 'UTC';
  const range = dateRange(days,now,timeZone,0);
  const comparison = {window:{start:shiftDate(range.start,-days),end:shiftDate(range.end,-days),timeZone},metrics:metricsFrom(totalsRow(total,1))};
  return {
    id:'ga4',name:'Google Analytics 4',status:reportRows(total).length ? 'ok' : 'empty',fetchedAt:now.toISOString(),range,comparison,metrics,
    daily:reportRows(daily).map(row=>({date:row.dimensions.date.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'),activeUsers:row.metrics.activeUsers,pageViews:row.metrics.screenPageViews})),
    pages:reportRows(pages).map(row=>({path:row.dimensions.pagePath,views:row.metrics.screenPageViews})),
    channels:reportRows(channels).map(row=>({name:row.dimensions.sessionDefaultChannelGroup,sessions:row.metrics.sessions})),
    events:reportRows(events).map(row=>({name:row.dimensions.eventName,count:row.metrics.eventCount})),
    milestones:milestoneRows.map(row=>({seconds:numeric(row.dimensions['customEvent:threshold_seconds']),count:row.metrics.eventCount})).filter(row=>row.seconds !== null),
    queries:[],note:`按媒体资源时区统计，包含今天；今日数据尚不完整，近两日数据仍可能调整。${Object.keys(optionalErrors).length ? '部分实时或游玩时长报表暂不可用，核心报表仍可读取。' : ''}`,
    metadata:{reports:reports.map(report=>report.metadata || {}),propertyQuota:total.propertyQuota || null,optionalErrors,realtimeWindowMinutes:30,timezoneConfirmed:Boolean(total.metadata?.timeZone)},
  };
}

async function readSearch(config,token,{days,now,fetchImpl}) {
  const range = dateRange(days,now,'America/Los_Angeles',3);
  const previous = {start:shiftDate(range.start,-days),end:shiftDate(range.end,-days)};
  const root = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(config.searchConsoleSite)}`;
  const headers = {Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  const query = (dimensions,extra={},window=range) => requestJSON(`${root}/searchAnalytics/query`,{fetchImpl,method:'POST',headers,body:JSON.stringify({startDate:window.start,endDate:window.end,type:'web',dataState:'final',dimensions,rowLimit:dimensions.includes('date') ? 28 : 10,...extra})});
  const results = await Promise.allSettled([query([],{aggregationType:'byProperty'}),query(['date'],{aggregationType:'byProperty'}),query(['query'],{aggregationType:'byProperty'}),query(['page']),requestJSON(`${root}/sitemaps`,{fetchImpl,headers}),query([],{aggregationType:'byProperty'},previous)]);
  const names = ['totals','daily','queries','pages','sitemaps','comparison'];
  const errors = Object.fromEntries(results.flatMap((result,index)=>result.status === 'rejected' ? [[names[index],safeError(result.reason)]] : []));
  if (results.slice(0,4).every(result=>result.status === 'rejected')) throw results[0].reason;
  const data = results.map(result=>result.status === 'fulfilled' ? result.value : null);
  const summary = data[0]?.rows?.[0];
  const metrics = Object.fromEntries(['clicks','impressions','ctr','position'].map(name=>[name,numeric(summary?.[name])]));
  const previousSummary = data[5]?.rows?.[0];
  const comparison = {window:{...previous,timeZone:range.timeZone},metrics:Object.fromEntries(['clicks','impressions','ctr','position'].map(name=>[name,numeric(previousSummary?.[name])]))};
  const daily = (data[1]?.rows || []).map(row=>({date:row.keys?.[0],clicks:numeric(row.clicks),impressions:numeric(row.impressions)})).sort((a,b)=>a.date.localeCompare(b.date));
  return {id:'search-console',name:'Google Search Console',status:data.slice(0,4).some(report=>report?.rows?.length) ? 'ok' : Object.keys(errors).length ? 'error' : 'empty',fetchedAt:now.toISOString(),range,comparison,metrics,daily,
    pages:(data[3]?.rows || []).map(row=>({path:row.keys?.[0] || '',clicks:numeric(row.clicks),impressions:numeric(row.impressions)})),
    queries:(data[2]?.rows || []).map(row=>({query:row.keys?.[0] || '',...Object.fromEntries(['clicks','impressions','ctr','position'].map(name=>[name,numeric(row[name])]))})),
    channels:[],events:[],milestones:[],sitemaps:data[4]?.sitemap?.map(item=>({path:item.path,lastSubmitted:item.lastSubmitted,lastDownloaded:item.lastDownloaded,isPending:item.isPending,warnings:numeric(item.warnings),errors:numeric(item.errors)})) ?? null,
    note:`太平洋时区、已定稿数据，结束日预留三天处理时间；未返回的日期不代表零流量，查询/页面榜单不含全部搜索。${Object.keys(errors).length ? '部分报表读取失败。' : ''}`,
    metadata:{optionalErrors:errors,latestReportedDate:daily.at(-1)?.date ?? null,dataState:'final',lagDays:3,topRowsOnly:true,aggregationType:data[0]?.responseAggregationType || null},
  };
}

export async function readGoogle(config,{days=7,now=new Date(),fetchImpl=fetch}={}) {
  days = Math.max(1,Math.min(28,Math.trunc(Number(days)) || 7));
  const available = config.googleServiceAccount || (config.googleClientId && config.googleClientSecret && config.googleRefreshToken);
  if (!available) return {ga4:unconfigured('ga4','Google Analytics 4','尚未配置 Google 只读授权。'),'search-console':unconfigured('search-console','Google Search Console','尚未配置 Google 只读授权。')};
  let token;
  try { token = await accessToken(config,fetchImpl); }
  catch(error) { return {ga4:providerFailure('ga4','Google Analytics 4',error,now),'search-console':providerFailure('search-console','Google Search Console',error,now)}; }
  const options = {days,now,fetchImpl};
  const results = await Promise.allSettled([config.gaPropertyId ? readGA(config,token,options) : Promise.resolve(unconfigured('ga4','Google Analytics 4','尚未配置媒体资源。')),config.searchConsoleSite ? readSearch(config,token,options) : Promise.resolve(unconfigured('search-console','Google Search Console','尚未配置站点资源。'))]);
  return Object.fromEntries(results.map((result,index)=>[index ? 'search-console' : 'ga4',result.status === 'fulfilled' ? result.value : providerFailure(index ? 'search-console' : 'ga4',index ? 'Google Search Console' : 'Google Analytics 4',result.reason,now)]));
}
