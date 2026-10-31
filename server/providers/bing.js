import {ProviderError, requestJSON, numeric, dateRange, shiftDate, unconfigured, providerFailure} from '../common.js';

const id = 'bing', name = 'Bing Webmaster';
const safeError = error => ({code:error instanceof ProviderError ? error.code : 'internal',status:error instanceof ProviderError ? error.status : null});
// Microsoft JSON dates contain an instant and optionally its original UTC offset.
// Keep Bing's reported calendar day rather than silently rebucketing into UTC.
export function bingDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(value);
  if (!match) return null;
  const offset = match[2];
  const minutes = offset ? (offset[0] === '-' ? -1 : 1) * (Number(offset.slice(1,3))*60 + Number(offset.slice(3))) : 0;
  const date = new Date(Number(match[1]) + minutes*60000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0,10) : null;
}
const stats = row => ({clicks:numeric(row.Clicks),impressions:numeric(row.Impressions)});
const ctr = (clicks,impressions) => clicks === null || impressions === null || impressions === 0 ? null : clicks/impressions;
function readRows(payload) {
  if (!payload || !Array.isArray(payload.d) || payload.d.some(row=>!row || typeof row !== 'object')) throw new ProviderError('response','Bing 返回的报表结构不完整。');
  return payload.d;
}

export async function readBing(config,{days=7,now=new Date(),fetchImpl=fetch}={}) {
  if (!config.bingApiKey || !config.bingSite) return unconfigured(id,name,'尚未配置 Bing Webmaster API 授权。');
  days = Math.max(1,Math.min(28,Math.trunc(Number(days)) || 7));
  const range = {...dateRange(days,now),timeZone:'Bing reported date'};
  const query = async method => {
    const url = new URL(`https://ssl.bing.com/webmaster/api.svc/json/${method}`);
    url.search = new URLSearchParams({siteUrl:config.bingSite,apikey:config.bingApiKey}).toString();
    return readRows(await requestJSON(url,{fetchImpl,headers:{Accept:'application/json'}}));
  };
  try {
    const methods = ['GetRankAndTrafficStats','GetPageStats','GetQueryStats','GetFeeds'];
    const results = await Promise.allSettled(methods.map(query));
    if (results[0].status === 'rejected') throw results[0].reason;
    const optionalErrors = Object.fromEntries(results.flatMap((result,index)=>result.status === 'rejected' ? [[methods[index],safeError(result.reason)]] : []));
    const data = index => results[index].status === 'fulfilled' ? results[index].value : [];
    const dated = index => data(index).map(row=>({...row,reportedDate:bingDate(row.Date)})).filter(row=>row.reportedDate && row.reportedDate >= range.start && row.reportedDate <= range.end);
    const daily = dated(0).map(row=>({date:row.reportedDate,...stats(row)})).sort((a,b)=>a.date.localeCompare(b.date));
    if (data(0).some(row=>!bingDate(row.Date) || numeric(row.Clicks) === null || numeric(row.Impressions) === null)) throw new ProviderError('response','Bing 返回的流量日期或指标无法读取。');
    const clicks = daily.length ? daily.reduce((sum,row)=>sum+row.clicks,0) : null;
    const impressions = daily.length ? daily.reduce((sum,row)=>sum+row.impressions,0) : null;
    // GetRankAndTrafficStats already returns recent weeks, so the previous period
    // is filtered from the same payload instead of requesting it again.
    const previousStart = shiftDate(range.start,-days), previousEnd = shiftDate(range.start,-1);
    const previousRows = data(0).filter(row=>{const reported=bingDate(row.Date);return reported && reported >= previousStart && reported <= previousEnd;});
    const previousClicks = previousRows.length ? previousRows.reduce((sum,row)=>sum+numeric(row.Clicks),0) : null;
    const previousImpressions = previousRows.length ? previousRows.reduce((sum,row)=>sum+numeric(row.Impressions),0) : null;
    const comparison = {window:{start:previousStart,end:previousEnd,timeZone:range.timeZone},metrics:{clicks:previousClicks,impressions:previousImpressions,ctr:ctr(previousClicks,previousImpressions),position:null}};
    // These endpoints return dated top rows, not a complete paginated export.
    const top = (index,key) => {
      const grouped = new Map();
      for (const row of dated(index)) {
        if (typeof row.Query !== 'string') continue;
        const values = stats(row);
        if (values.clicks === null || values.impressions === null) continue;
        const current = grouped.get(row.Query) || {[key]:row.Query,clicks:0,impressions:0,weightedPosition:0,positionWeight:0};
        current.clicks += values.clicks; current.impressions += values.impressions;
        const position = numeric(row.AvgImpressionPosition);
        if (position !== null && values.impressions > 0) { current.weightedPosition += position*values.impressions; current.positionWeight += values.impressions; }
        grouped.set(row.Query,current);
      }
      return [...grouped.values()].sort((a,b)=>b.clicks-a.clicks || b.impressions-a.impressions).slice(0,10).map(row=>({[key]:row[key],clicks:row.clicks,impressions:row.impressions,ctr:ctr(row.clicks,row.impressions),position:row.positionWeight ? row.weightedPosition/row.positionWeight : null}));
    };
    const sitemaps = results[3].status === 'fulfilled' ? data(3).slice(0,100).map(row=>({path:typeof row.Url === 'string' ? row.Url : '',status:typeof row.Status === 'string' ? row.Status : null,type:typeof row.Type === 'string' ? row.Type : null,lastDownloaded:bingDate(row.LastCrawled),lastSubmitted:bingDate(row.Submitted),urlCount:numeric(row.UrlCount)})) : null;
    return {id,name,status:daily.length ? 'ok' : 'empty',fetchedAt:now.toISOString(),range,comparison,metrics:{clicks,impressions,ctr:ctr(clicks,impressions),position:null},daily,pages:top(1,'path'),queries:top(2,'query'),channels:[],sitemaps,
      note:`按 Bing 返回日期筛选；每日流量涵盖 Web、Chat、News、Images、Videos 和 Knowledge Panel，不能当作纯网页搜索。查询与页面榜单周更且只含热门行，缺失日期不是零。${Object.keys(optionalErrors).length ? '部分明细暂不可用。' : ''}`,
      metadata:{optionalErrors,latestReportedDate:data(0).map(row=>bingDate(row.Date)).filter(Boolean).sort().at(-1) ?? null,topRowsOnly:true,queryPageCadence:'weekly',trafficCadence:'daily',dateBoundary:'UTC dates requested; response calendar dates retain Bing offset',sitemapRowsLimited:100}};
  } catch (error) { return providerFailure(id,name,error,now); }
}
