import {ProviderError, requestJSON, numeric, dateRange, shiftDate, unconfigured, providerFailure} from '../common.js';

const id = 'cloudflare', name = 'Cloudflare Web Analytics';
const dataset = 'rumPageloadEventsAdaptiveGroups';
const safeError = error => ({code:error instanceof ProviderError ? error.code : 'internal',status:error instanceof ProviderError ? error.status : null});
const dayMs = 86400000;

export async function readCloudflare(config,{days=7,now=new Date(),fetchImpl=fetch}={}) {
  if (!config.cloudflareToken || !config.cloudflareAccountId || !config.cloudflareSiteTag) return unconfigured(id,name,'尚未配置 Cloudflare Account Analytics Read 授权。');
  days = Math.max(1,Math.min(28,Math.trunc(Number(days)) || 7));
  const requestedRange = dateRange(days,now,'UTC',0);
  const range = {...requestedRange};
  const graphql = async selection => {
    const query = `query { viewer { accounts(filter: {accountTag: ${JSON.stringify(config.cloudflareAccountId)}}) { ${selection} } } }`;
    const payload = await requestJSON('https://api.cloudflare.com/client/v4/graphql',{fetchImpl,method:'POST',headers:{Authorization:`Bearer ${config.cloudflareToken}`,'Content-Type':'application/json'},body:JSON.stringify({query})});
    // GraphQL failures can have HTTP 200 and contain upstream details or tokens.
    if (!payload || (Array.isArray(payload.errors) && payload.errors.length)) throw new ProviderError('upstream','Cloudflare 统计查询失败，请核对只读权限和数据集可用性。');
    const accounts = payload.data?.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1 || !accounts[0]) throw new ProviderError('response','Cloudflare 返回的账户报表结构不完整。');
    return accounts[0];
  };
  try {
    const settings = (await graphql(`settings { ${dataset} { enabled maxDuration maxPageSize notOlderThan availableFields } }`)).settings?.[dataset];
    if (!settings || settings.enabled !== true) throw new ProviderError('authorization','Cloudflare 未开放此账户的 Web Analytics 数据集。');
    const maxDuration = numeric(settings.maxDuration), notOlderThan = numeric(settings.notOlderThan), maxPageSize = numeric(settings.maxPageSize);
    if (maxDuration === null || maxDuration < 86400 || notOlderThan === null || notOlderThan < 86400 || maxPageSize === null || maxPageSize < 1) throw new ProviderError('response','Cloudflare 数据集的查询限制无法读取。');
    const available = Array.isArray(settings.availableFields) ? new Set(settings.availableFields) : null;
    const has = field => available?.has(field) === true;
    if (!has('count') || !has('sum_visits') || !has('dimensions_date')) throw new ProviderError('response','Cloudflare 数据集缺少页面浏览、访问次数或日期字段。');
    // Retention is measured from now, so omit a boundary day if only part survives.
    const oldest = new Date(Math.ceil((now.getTime()-notOlderThan*1000)/dayMs)*dayMs).toISOString().slice(0,10);
    if (range.start < oldest) range.start = oldest;
    if (range.start > range.end) throw new ProviderError('range','Cloudflare 当前保留范围没有完整自然日。');
    const chunkDays = Math.max(1,Math.min(days,Math.floor(maxDuration/86400),Math.floor(maxPageSize)));
    const samplingField = has('avg_sampleInterval') ? 'avg { sampleInterval }' : '';
    const metricsFields = `count sum { visits } ${samplingField}`;
    const upperBound = end => new Date(Math.min(Date.parse(`${shiftDate(end,1)}T00:00:00Z`),now.getTime())).toISOString();
    const filter = (start,end) => `{siteTag:${JSON.stringify(config.cloudflareSiteTag)},datetime_geq:${JSON.stringify(`${start}T00:00:00Z`)},datetime_lt:${JSON.stringify(upperBound(end))}}`;
    const daily = [], sampleIntervals = [];
    // Page views and visits are additive over disjoint time slices. They are not unique visitors.
    let pageViews = 0, visits = 0;
    for (let start=range.start; start<=range.end; start=shiftDate(start,chunkDays)) {
      const end = [shiftDate(start,chunkDays-1),range.end].sort()[0];
      const account = await graphql(`total: ${dataset}(limit:1,filter:${filter(start,end)}) { ${metricsFields} } daily: ${dataset}(limit:${chunkDays},filter:${filter(start,end)},orderBy:[date_ASC]) { ${metricsFields} dimensions { date } }`);
      if (!Array.isArray(account.total) || !Array.isArray(account.daily) || account.total.length > 1) throw new ProviderError('response','Cloudflare 返回的流量汇总结构不完整。');
      if (Boolean(account.total.length) !== Boolean(account.daily.length)) throw new ProviderError('response','Cloudflare 返回的流量汇总与日期报表不一致。');
      for (const row of [...account.total,...account.daily]) {
        if (numeric(row.count) === null || numeric(row.sum?.visits) === null) throw new ProviderError('response','Cloudflare 返回的流量指标无法读取。');
        const sample = numeric(row.avg?.sampleInterval); if (sample !== null) sampleIntervals.push(sample);
      }
      pageViews += numeric(account.total[0]?.count) ?? 0; visits += numeric(account.total[0]?.sum?.visits) ?? 0;
      for (const row of account.daily) {
        const date = row.dimensions?.date;
        if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < start || date > end) throw new ProviderError('response','Cloudflare 返回的流量日期无法读取。');
        daily.push({date,pageViews:numeric(row.count),visits:numeric(row.sum.visits)});
      }
    }
    const details = {}, optionalErrors = {};
    const detailDimensions = {pages:'requestPath',channels:'refererHost',countries:'countryName',devices:'deviceType'};
    const duration = (Date.parse(upperBound(range.end))-Date.parse(`${range.start}T00:00:00Z`))/1000;
    const detailResults = await Promise.allSettled(Object.entries(detailDimensions).map(async ([key,dimension])=>{
      // Do not merge per-chunk top lists into a misleading whole-period ranking.
      if (duration > maxDuration || !has(`dimensions_${dimension}`)) throw new ProviderError('coverage','此期间的维度报表超出当前数据集能力。');
      const account = await graphql(`rows: ${dataset}(limit:${Math.min(10,Math.floor(maxPageSize))},filter:${filter(range.start,range.end)},orderBy:[count_DESC]) { count dimensions { ${dimension} } }`);
      if (!Array.isArray(account.rows) || account.rows.some(row=>numeric(row.count) === null || typeof row.dimensions?.[dimension] !== 'string')) throw new ProviderError('response','Cloudflare 返回的明细结构不完整。');
      return [key,account.rows.slice(0,10).map(row=>({[key === 'pages' ? 'path' : 'name']:row.dimensions[dimension],views:numeric(row.count)}))];
    }));
    detailResults.forEach((result,index)=>{const key=Object.keys(detailDimensions)[index]; if(result.status === 'fulfilled') details[key]=result.value[1]; else {details[key]=[]; optionalErrors[key]=safeError(result.reason);}});
    // Compare only against a fully retained previous window; a partial one
    // would fabricate a trend that retention cannot support.
    const previousWindow = {start:shiftDate(requestedRange.start,-days),end:shiftDate(requestedRange.start,-1)};
    let comparison = null;
    if (previousWindow.start >= oldest) {
      try {
        let previousViews = 0, previousVisits = 0;
        for (let start=previousWindow.start; start<=previousWindow.end; start=shiftDate(start,chunkDays)) {
          const end = [shiftDate(start,chunkDays-1),previousWindow.end].sort()[0];
          const account = await graphql(`total: ${dataset}(limit:1,filter:${filter(start,end)}) { ${metricsFields} }`);
          if (!Array.isArray(account.total) || account.total.length > 1) throw new ProviderError('response','Cloudflare 返回的对比汇总结构不完整。');
          for (const row of account.total) if (numeric(row.count) === null || numeric(row.sum?.visits) === null) throw new ProviderError('response','Cloudflare 返回的对比指标无法读取。');
          previousViews += numeric(account.total[0]?.count) ?? 0; previousVisits += numeric(account.total[0]?.sum?.visits) ?? 0;
        }
        comparison = {window:{...previousWindow,timeZone:'UTC'},metrics:{pageViews:previousViews,visits:previousVisits}};
      } catch (error) { optionalErrors.comparison = safeError(error); }
    }
    const coverageLimited = range.start !== requestedRange.start;
    const observedIntervals = [...new Set(sampleIntervals)];
    const samplingObserved = observedIntervals.length > 0 ? observedIntervals.some(value=>value>1) : null;
    return {id,name,status:daily.length ? 'ok' : 'empty',fetchedAt:now.toISOString(),range,comparison,metrics:{pageViews:daily.length ? pageViews : null,visits:daily.length ? visits : null},daily:daily.sort((a,b)=>a.date.localeCompare(b.date)),...details,queries:[],
      note:`按 UTC 自然日统计，包含今天截至读取时的数据，今日数据仍会变化。浏览器 RUM；visits 是访问次数，不是去重访客。${samplingObserved ? `本次已观察到抽样（采样间隔 ${observedIntervals.join(' / ')}），数值为估计值，不同日期范围的估计结果不保证严格可加。` : '数据可能采样。'}拦截或未执行脚本的访问不会出现。${coverageLimited ? '保留期限缩短了实际显示期间。' : ''}${!comparison && previousWindow.start < oldest ? '上一期间超出保留期限，不显示环比。' : ''}${Object.keys(optionalErrors).length ? '部分维度因查询能力或读取失败暂不可用。' : ''}`,
      metadata:{requestedRange,coverageLimited,optionalErrors,topRowsOnly:true,sampling:'adaptive',sampleIntervals:observedIntervals,samplingObserved,limits:{maxDuration,notOlderThan,maxPageSize},includesPartialToday:true,dataThrough:now.toISOString()}};
  } catch(error) { return providerFailure(id,name,error,now); }
}
