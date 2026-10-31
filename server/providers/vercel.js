import {ProviderError, requestJSON, numeric, dateRange, unconfigured, providerFailure} from '../common.js';

const id = 'vercel', name = 'Vercel Web Analytics';
const safeError = error => ({code:error instanceof ProviderError ? error.code : 'internal',status:error instanceof ProviderError ? error.status : null});
function rows(payload) {
  if (!payload || !Array.isArray(payload.data) || payload.data.some(row => !row || numeric(row.pageviews) === null || numeric(row.visitors) === null)) {
    throw new ProviderError('response','Vercel 返回的报表结构不完整。');
  }
  return payload.data;
}

export async function readVercel(config,{days=7,now=new Date(),fetchImpl=fetch}={}) {
  if (!config.vercelToken || !config.vercelProjectId) return unconfigured(id,name,'尚未配置 Vercel 统计读取授权。');
  days = Math.max(1,Math.min(28,Math.trunc(Number(days)) || 7));
  const range = dateRange(days,now,'UTC',0);
  const query = async (by,limit=10) => {
    const url = new URL('https://api.vercel.com/v1/query/web-analytics/visits/aggregate');
    // OpenAPI requires at least one dimension. The single production environment
    // group preserves period-distinct visitors; daily visitor counts cannot do so.
    url.search = new URLSearchParams({projectId:config.vercelProjectId,by,since:`${range.start}T00:00:00.000Z`,until:now.toISOString(),limit:String(limit),filter:"environment eq 'production'"}).toString();
    if (config.vercelTeamId) url.searchParams.set('teamId',config.vercelTeamId);
    const result = rows(await requestJSON(url,{fetchImpl,headers:{Authorization:`Bearer ${config.vercelToken}`}}));
    if (by === 'day' && result.some(row=>typeof row.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(row.timestamp) || !Number.isFinite(Date.parse(row.timestamp)))) throw new ProviderError('response','Vercel 返回的流量日期无法读取。');
    if (by !== 'day' && result.some(row=>typeof row[by] !== 'string')) throw new ProviderError('response','Vercel 返回的明细维度无法读取。');
    return result;
  };
  try {
    const groups = ['environment','day','requestPath','referrerHostname','country','deviceType'];
    const results = await Promise.allSettled(groups.map(group=>query(group,group === 'day' ? 28 : 10)));
    if (results[0].status === 'rejected') throw results[0].reason;
    const totalRows = results[0].value;
    if (totalRows.length > 1 || (totalRows.length === 1 && totalRows[0].environment !== 'production')) throw new ProviderError('response','Vercel 未返回唯一的正式环境汇总。');
    const optionalErrors = Object.fromEntries(results.flatMap((result,index)=>result.status === 'rejected' ? [[groups[index],safeError(result.reason)]] : []));
    const detail = group => results[groups.indexOf(group)].status === 'fulfilled' ? results[groups.indexOf(group)].value : [];
    const metrics = {pageViews:numeric(totalRows[0]?.pageviews),visitors:numeric(totalRows[0]?.visitors)};
    const ranked = (group,key) => detail(group).slice(0,10).map(row=>({[key]:row[group],views:numeric(row.pageviews),visitors:numeric(row.visitors)}));
    const daily = detail('day').map(row=>({date:typeof row.timestamp === 'string' ? row.timestamp.slice(0,10) : '',pageViews:numeric(row.pageviews),visitors:numeric(row.visitors)})).filter(row=>/^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.date >= range.start && row.date <= range.end).sort((a,b)=>a.date.localeCompare(b.date));
    return {id,name,status:totalRows.length ? 'ok' : 'empty',fetchedAt:now.toISOString(),range,metrics,daily,pages:ranked('requestPath','path'),channels:ranked('referrerHostname','name'),countries:ranked('country','name'),devices:ranked('deviceType','name'),queries:[],
      note:`按 UTC 自然日统计，包含今天截至读取时的数据，今日数据仍会变化。仅正式环境；访客数取整个期间的唯一环境分组，不能与其他来源相加。Hobby 保留一个月报表、每月 50,000 次事件，达到额度可能暂停收集。${Object.keys(optionalErrors).length ? '部分明细暂不可用。' : ''}`,
      metadata:{optionalErrors,topRowsOnly:true,totalsGrouping:'environment',environment:'production',reportingWindowMonths:1,includesPartialToday:true,dataThrough:now.toISOString()}};
  } catch (error) { return providerFailure(id,name,error,now); }
}
