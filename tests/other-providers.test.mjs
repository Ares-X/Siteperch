import test from 'node:test';
import assert from 'node:assert/strict';
import {readVercel} from '../server/providers/vercel.js';
import {readBing,bingDate} from '../server/providers/bing.js';
import {readCloudflare} from '../server/providers/cloudflare.js';

const now = new Date('2026-10-27T12:00:00Z');
const json = value => new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
const config = {vercelToken:'secret-vercel',vercelProjectId:'project',vercelTeamId:'team',cloudflareToken:'secret-cf',cloudflareAccountId:'account',cloudflareSiteTag:'site',bingApiKey:'secret-bing',bingSite:'https://example.com/'};
const bingStamp = date => `/Date(${Date.parse(`${date}T00:00:00Z`)})/`;

test('all unconfigured providers avoid network calls',async()=>{
  const fetchImpl = ()=>{throw new Error('unexpected fetch');};
  for (const read of [readVercel,readBing,readCloudflare]) assert.equal((await read({}, {fetchImpl,now})).status,'unconfigured');
});

test('Vercel reads period-distinct visitors from a unique production group',async()=>{
  const requests = [];
  const result = await readVercel(config,{now,fetchImpl:async(input,options)=>{
    const url = new URL(input); requests.push(url);
    assert.equal(options.headers.Authorization,'Bearer secret-vercel');
    assert.equal(url.searchParams.get('projectId'),'project');
    assert.equal(url.searchParams.get('teamId'),'team');
    assert.equal(url.searchParams.get('filter'),"environment eq 'production'");
    assert.equal(url.searchParams.get('since'),'2026-10-21T00:00:00.000Z');
    assert.equal(url.searchParams.get('until'),now.toISOString());
    const by = url.searchParams.get('by');
    if (by === 'environment') return json({data:[{environment:'production',pageviews:20,visitors:5}]});
    if (by === 'day') return json({data:[{timestamp:'2026-10-21T00:00:00Z',pageviews:10,visitors:4},{timestamp:'2026-10-27T00:00:00Z',pageviews:10,visitors:4}]});
    return json({data:[{[by]:by === 'requestPath' ? '/' : 'value',pageviews:20,visitors:5}]});
  }});
  assert.equal(requests.length,6);
  assert.equal(result.metrics.visitors,5); assert.equal(result.daily.reduce((sum,row)=>sum+row.visitors,0),8);
  assert.equal(result.metrics.pageViews,20); assert.equal(result.pages[0].path,'/');
  assert.equal(result.status,'ok'); assert.equal(result.range.timeZone,'UTC');
  assert.equal(result.daily.at(-1).date,'2026-10-27'); assert.equal(result.metadata.includesPartialToday,true);
});

test('Vercel invalid totals do not fabricate totals by summing detail rows',async()=>{
  const result = await readVercel(config,{now,fetchImpl:async input=>new URL(input).searchParams.get('by') === 'environment' ? json({data:[{environment:'production',pageviews:5,visitors:4},{environment:'preview',pageviews:3,visitors:2}]}) : json({data:[]})});
  assert.equal(result.status,'error'); assert.equal(result.error.code,'response');
});

test('28-day Vercel range includes today and preserves a reported zero',async()=>{
  const result = await readVercel(config,{days:28,now,fetchImpl:async input=>{
    const url=new URL(input);
    assert.equal(url.searchParams.get('since'),'2026-09-30T00:00:00.000Z');
    assert.equal(url.searchParams.get('until'),now.toISOString());
    return json({data:url.searchParams.get('by') === 'environment' ? [{environment:'production',pageviews:0,visitors:0}] : []});
  }});
  assert.equal(result.range.end,'2026-10-27'); assert.equal(result.metrics.pageViews,0); assert.equal(result.metrics.visitors,0); assert.equal(result.status,'ok');
});

test('Vercel keeps core stats when an optional dimension fails',async()=>{
  const result = await readVercel(config,{now,fetchImpl:async input=>{
    const group = new URL(input).searchParams.get('by');
    if (group === 'country') return new Response('secret-vercel',{status:403});
    return json({data:group === 'environment' ? [{environment:'production',pageviews:5,visitors:4}] : []});
  }});
  assert.equal(result.status,'ok'); assert.equal(result.metadata.optionalErrors.country.code,'authorization');
  assert.ok(!JSON.stringify(result).includes('secret-vercel'));
});

test('Bing preserves the reported calendar date including negative offsets',()=>{
  assert.equal(bingDate('/Date(1316156400000-0700)/'),'2011-09-16');
  assert.equal(bingDate(`/Date(${Date.parse('2026-10-20T02:00:00Z')}-0700)/`),'2026-10-19');
  assert.equal(bingDate('bad'),null);
});

test('Bing filters dated rows and preserves traffic despite optional failures',async()=>{
  const result = await readBing(config,{now,fetchImpl:async input=>{
    const url = new URL(input);
    assert.equal(url.hostname,'ssl.bing.com'); assert.equal(url.searchParams.get('apikey'),'secret-bing');
    assert.equal(url.searchParams.get('siteUrl'),'https://example.com/');
    assert.equal(url.searchParams.size,2);
    if (url.pathname.endsWith('GetRankAndTrafficStats')) return json({d:[{Date:bingStamp('2026-10-19'),Clicks:500,Impressions:1000},{Date:bingStamp('2026-10-20'),Clicks:2,Impressions:20},{Date:bingStamp('2026-10-26'),Clicks:1,Impressions:10},{Date:bingStamp('2026-10-27'),Clicks:900,Impressions:1000}]});
    if (url.pathname.endsWith('GetPageStats')) return json({d:[{Date:bingStamp('2026-10-20'),Query:'https://example.com/',Clicks:2,Impressions:20,AvgImpressionPosition:3},{Date:bingStamp('2026-10-26'),Query:'https://example.com/',Clicks:1,Impressions:10,AvgImpressionPosition:6}]});
    if (url.pathname.endsWith('GetQueryStats')) throw new Error(`failure ${input}`);
    return json({d:[{Url:'https://example.com/sitemap.xml',Status:'Success',Type:'Sitemap',LastCrawled:bingStamp('2026-10-26'),UrlCount:2,PrivateProperty:'must not escape'}]});
  }});
  assert.equal(result.status,'ok'); assert.equal(result.metrics.clicks,3); assert.equal(result.metrics.impressions,30); assert.equal(result.metrics.ctr,.1);
  assert.equal(result.pages[0].position,4); assert.equal(result.sitemaps[0].status,'Success');
  assert.equal(result.metadata.optionalErrors.GetQueryStats.code,'network');
  assert.ok(!JSON.stringify(result).includes('secret-bing')); assert.ok(!JSON.stringify(result).includes('must not escape'));
});

test('Bing error payload is not empty success or leaked data',async()=>{
  const result = await readBing(config,{now,fetchImpl:async()=>json({ErrorCode:18,Message:'secret-bing'})});
  assert.equal(result.status,'error'); assert.ok(!JSON.stringify(result).includes('secret-bing'));
});

const settings = {enabled:true,maxDuration:86400*31,maxPageSize:100,notOlderThan:86400*180,availableFields:['count','sum_visits','dimensions_date','dimensions_requestPath','dimensions_refererHost','dimensions_countryName','dimensions_deviceType','avg_sampleInterval']};
const cfResponse = account => json({data:{viewer:{accounts:[account]}},errors:null});

test('Cloudflare discovers settings and separates visits from unique visitors',async()=>{
  const queries = [];
  const result = await readCloudflare(config,{now,fetchImpl:async(_input,options)=>{
    assert.equal(options.headers.Authorization,'Bearer secret-cf');
    const {query} = JSON.parse(options.body); queries.push(query);
    if (query.includes('settings {')) return cfResponse({settings:{rumPageloadEventsAdaptiveGroups:settings}});
    if (query.includes('total:')) return cfResponse({total:[{count:12,sum:{visits:6},avg:{sampleInterval:2}}],daily:[{count:12,sum:{visits:6},dimensions:{date:'2026-10-27'},avg:{sampleInterval:2}}]});
    const dimension = /dimensions \{ (\w+) \}/.exec(query)[1];
    return cfResponse({rows:[{count:12,dimensions:{[dimension]:dimension === 'requestPath' ? '/' : 'value'}}]});
  }});
  assert.equal(result.status,'ok'); assert.deepEqual(result.metrics,{pageViews:12,visits:6});
  assert.equal(result.metadata.samplingObserved,true); assert.equal(result.pages[0].path,'/');
  assert.ok(queries[1].includes('siteTag:"site"')); assert.ok(queries[1].includes('datetime_geq:"2026-10-21T00:00:00Z"')); assert.ok(queries[1].includes(`datetime_lt:"${now.toISOString()}"`));
  assert.equal(result.daily[0].date,'2026-10-27'); assert.equal(result.metadata.includesPartialToday,true);
  assert.equal('visitors' in result.metrics,false);
});

test('Cloudflare chunks within maxDuration and never merges truncated detail rankings',async()=>{
  let chunks = 0; const bounds=[];
  const result = await readCloudflare(config,{now,fetchImpl:async(_input,options)=>{
    const {query} = JSON.parse(options.body);
    if(query.includes('settings {')) return cfResponse({settings:{rumPageloadEventsAdaptiveGroups:{...settings,maxDuration:86400*2}}});
    assert.ok(query.includes('total:')); chunks++;
    const start = /datetime_geq:"([\d-]+)T/.exec(query)[1];
    const upper = /datetime_lt:"([^"]+)"/.exec(query)[1];
    assert.ok(Date.parse(upper)-Date.parse(`${start}T00:00:00Z`)<=2*86400000);
    assert.ok(Date.parse(upper)<=now.getTime()); bounds.push({start,upper});
    return cfResponse({total:[{count:1,sum:{visits:1}}],daily:[{count:1,sum:{visits:1},dimensions:{date:start}}]});
  }});
  assert.equal(chunks,4); assert.equal(result.metrics.pageViews,4); assert.deepEqual(result.pages,[]); assert.equal(result.metadata.optionalErrors.pages.code,'coverage');
  assert.equal(bounds[0].upper,'2026-10-23T00:00:00.000Z'); assert.equal(bounds.at(-1).upper,now.toISOString());
});

test('Cloudflare retention cannot silently claim the full selected period',async()=>{
  const result = await readCloudflare(config,{now,fetchImpl:async(_input,options)=>{
    const {query} = JSON.parse(options.body);
    if (query.includes('settings {')) return cfResponse({settings:{rumPageloadEventsAdaptiveGroups:{...settings,notOlderThan:86400*3}}});
    if (query.includes('total:')) return cfResponse({total:[],daily:[]});
    return cfResponse({rows:[]});
  }});
  assert.equal(result.range.start,'2026-10-25'); assert.equal(result.metadata.coverageLimited,true); assert.equal(result.status,'empty');
});

test('Cloudflare omits unadvertised sample and detail fields while preserving zero',async()=>{
  const result=await readCloudflare(config,{days:28,now,fetchImpl:async(_input,options)=>{
    const {query}=JSON.parse(options.body);
    if(query.includes('settings {')) return cfResponse({settings:{rumPageloadEventsAdaptiveGroups:{...settings,availableFields:['count','sum_visits','dimensions_date']}}});
    assert.ok(!query.includes('sampleInterval')); assert.ok(!query.includes('rows:'));
    assert.ok(query.includes('datetime_geq:"2026-09-30T00:00:00Z"'));
    assert.ok(query.includes(`datetime_lt:"${now.toISOString()}"`));
    return cfResponse({total:[{count:0,sum:{visits:0}}],daily:[{count:0,sum:{visits:0},dimensions:{date:'2026-10-27'}}]});
  }});
  assert.equal(result.status,'ok'); assert.equal(result.metrics.pageViews,0); assert.equal(result.metrics.visits,0);
  assert.equal(result.metadata.samplingObserved,null); assert.equal(result.metadata.optionalErrors.pages.code,'coverage');
});

test('Cloudflare HTTP-200 GraphQL errors are errors without leaking their messages',async()=>{
  const result = await readCloudflare(config,{now,fetchImpl:async()=>json({errors:[{message:'secret-cf'}]})});
  assert.equal(result.status,'error'); assert.ok(!JSON.stringify(result).includes('secret-cf'));
});
