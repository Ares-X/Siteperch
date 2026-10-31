import test from 'node:test';
import assert from 'node:assert/strict';
import {readGoogle} from '../server/providers/google.js';

let counter = 0;
const config = () => ({gaPropertyId:'123456789',searchConsoleSite:'sc-domain:example.com',googleClientId:`fixture-client-${++counter}`,googleClientSecret:'fixture-secret',googleRefreshToken:'fixture-refresh'});
const now = new Date('2026-10-27T01:00:00Z');
const response = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function report(dimensions,metrics,values,keys=[],metadata={timeZone:'Asia/Shanghai'}) {
  return {dimensionHeaders:dimensions.map(name=>({name})),metricHeaders:metrics.map(name=>({name})),rows:values.map((row,index)=>({dimensionValues:(keys[index] || []).map(value=>({value})),metricValues:row.map(value=>({value}))})),metadata};
}
function fixtureFetch(override = () => null) {
  const calls = [];
  const fetchImpl = async (url,options) => {
    calls.push({url,options,body:options.body?.startsWith('{') ? JSON.parse(options.body) : options.body});
    const custom = await override(url,options,calls);
    if (custom) return custom;
    if (url.endsWith('/token')) return response({access_token:'fixture-provider-access-token',expires_in:3600});
    if (url.endsWith(':batchRunReports')) return response({reports:[
      report(['dateRange'],['activeUsers','newUsers','sessions','screenPageViews','engagementRate'],[['8','3','12','18','0'],['7','2','10','15','0.1']],[['date_range_0'],['date_range_1']]),
      report(['date'],['activeUsers','screenPageViews'],[['7','10'],['6','8']],[['20261025'],['20261026']]),
      report(['pagePath'],['screenPageViews'],[['18']],[['/']]),
      report(['sessionDefaultChannelGroup'],['sessions'],[['12']],[['Direct']]),
      report(['eventName'],['eventCount','eventValue'],[['3','180']],[['play_milestone']]),
    ]});
    if (url.endsWith(':runRealtimeReport')) {
      const request=JSON.parse(options.body);
      return response(report((request.dimensions || []).map(item=>item.name),request.metrics.map(item=>item.name),[]));
    }
    if (url.endsWith(':runReport')) return response(report(['customEvent:threshold_seconds'],['eventCount'],[['2'],['1']],[['60'],['(not set)']]));
    if (url.endsWith('/sitemaps')) return response({sitemap:[{path:'https://example.com/sitemap.xml',errors:'0',warnings:'1'}]});
    if (url.endsWith('/searchAnalytics/query')) {
      const {dimensions} = JSON.parse(options.body);
      return response({rows:[{keys:dimensions.length ? [dimensions[0] === 'date' ? '2026-10-22' : dimensions[0] === 'page' ? 'https://example.com/' : 'lonely sky'] : [],clicks:0,impressions:10,ctr:0,position:4.2}],responseAggregationType:'byProperty'});
    }
    throw new Error('unexpected fixture request');
  };
  return {calls,fetchImpl};
}

test('no authorization means unconfigured and no network request',async()=>{
  const result = await readGoogle({}, {fetchImpl:()=>{throw new Error('must not fetch');}});
  assert.equal(result.ga4.status,'unconfigured');
  assert.equal(result['search-console'].status,'unconfigured');
});

test('unused Google credentials do not cause token requests or configuration errors',async()=>{
  for (const credentials of [config(),{googleServiceAccount:'fixture-unused-invalid-json'}]) {
    let calls = 0;
    const result = await readGoogle({...credentials,gaPropertyId:'',searchConsoleSite:''},{now,fetchImpl:async()=>{calls++; return response({},401);}});
    assert.equal(calls,0);
    assert.equal(result.ga4.status,'unconfigured');
    assert.equal(result['search-console'].status,'unconfigured');
    assert.equal(result.ga4.error,undefined);
    assert.equal(result['search-console'].error,undefined);
  }
});

test('token failures only affect the configured Google targets',async()=>{
  for (const [gaEnabled,searchEnabled] of [[false,false],[true,false],[false,true],[true,true]]) {
    const cfg = {...config(),gaPropertyId:gaEnabled ? '123456789' : '',searchConsoleSite:searchEnabled ? 'sc-domain:example.com' : ''};
    const fixture = fixtureFetch(url=>url.endsWith('/token') ? response({error:'fixture-refresh'},401) : null);
    const result = await readGoogle(cfg,{now,fetchImpl:fixture.fetchImpl});
    assert.equal(fixture.calls.length,gaEnabled || searchEnabled ? 1 : 0);
    assert.equal(result.ga4.status,gaEnabled ? 'error' : 'unconfigured');
    assert.equal(result['search-console'].status,searchEnabled ? 'error' : 'unconfigured');
    if (gaEnabled) assert.equal(result.ga4.error.code,'authorization');
    if (searchEnabled) assert.equal(result['search-console'].error.code,'authorization');
    assert.ok(!JSON.stringify(result).includes('fixture-refresh'));
  }
});

test('single Google target fetches only its own reports',async()=>{
  for (const id of ['ga4','search-console']) {
    const cfg = {...config(),gaPropertyId:id === 'ga4' ? '123456789' : '',searchConsoleSite:id === 'search-console' ? 'sc-domain:example.com' : ''};
    const fixture = fixtureFetch();
    const result = await readGoogle(cfg,{now,fetchImpl:fixture.fetchImpl});
    assert.equal(result[id].status,'ok');
    assert.equal(result[id === 'ga4' ? 'search-console' : 'ga4'].status,'unconfigured');
    const reports = fixture.calls.filter(call=>!call.url.endsWith('/token'));
    assert.ok(reports.length > 0);
    assert.ok(reports.every(call=>id === 'ga4' ? call.url.startsWith('https://analyticsdata.googleapis.com/') : call.url.startsWith('https://www.googleapis.com/webmasters/')));
  }
});

test('generic events do not request the game-specific milestone dimension',async()=>{
  for (const eventConfig of [undefined,{preset:'generic'}]) {
    const fixture = fixtureFetch(url=>url.endsWith(':runReport') ? response({},400) : null);
    const result = await readGoogle({...config(),eventConfig},{now,fetchImpl:fixture.fetchImpl});
    assert.equal(result.ga4.status,'ok');
    assert.equal(result.ga4.metadata.milestonesEnabled,false);
    assert.deepEqual(result.ga4.milestones,[]);
    assert.deepEqual(result.ga4.metadata.optionalErrors,{});
    assert.deepEqual(result.ga4.events,[{name:'play_milestone',count:3,value:180}]);
    assert.equal(fixture.calls.some(call=>call.url.endsWith(':runReport')),false);
    assert.ok(!JSON.stringify(fixture.calls).includes('customEvent:threshold_seconds'));
  }
});

test('realtime success, zero and failure stay distinct when historical reports are empty',async()=>{
  const realtimeCases = [
    {body:report([],['activeUsers'],[['9']]),status:200,count:9,reportStatus:'ok'},
    {body:{kind:'analyticsData#runRealtimeReport'},status:200,count:0,reportStatus:'ok'},
    {body:{},status:403,count:null,reportStatus:'error'},
  ];
  for (const realtime of realtimeCases) {
    const fixture = fixtureFetch((url,options)=>{
      if (url.endsWith(':batchRunReports')) {
        return response({reports:JSON.parse(options.body).requests.map(request=>report(request.dimensions.map(item=>item.name),request.metrics.map(item=>item.name),[]))});
      }
      if (url.endsWith(':runRealtimeReport') && !JSON.parse(options.body).dimensions) return response(realtime.body,realtime.status);
      return null;
    });
    const result = await readGoogle(config(),{now,fetchImpl:fixture.fetchImpl});
    assert.equal(result.ga4.status,'empty');
    assert.equal(result.ga4.metrics.activeUsers,null);
    assert.equal(result.ga4.metrics.realtimeUsers,realtime.count);
    assert.equal(result.ga4.metadata.realtimeStatus,realtime.reportStatus);
    if (realtime.reportStatus === 'error') assert.equal(result.ga4.metadata.optionalErrors.realtime.code,'authorization');
    else assert.equal(result.ga4.metadata.optionalErrors.realtime,undefined);
  }
});

test('declared provider fixtures preserve distinct totals, zeroes and canonical request shapes',async()=>{
  const fixture = fixtureFetch();
  const result = await readGoogle({...config(),eventConfig:{preset:'lonelysky'}},{now,days:90,fetchImpl:fixture.fetchImpl});
  assert.equal(result.ga4.metrics.activeUsers,8);
  assert.equal(result.ga4.daily[0].activeUsers,7);
  assert.equal(result.ga4.metrics.engagementRate,0);
  assert.equal(result.ga4.metrics.realtimeUsers,0);
  assert.equal(result.ga4.metadata.realtimeStatus,'ok');
  assert.equal(result.ga4.metadata.milestonesEnabled,true);
  assert.deepEqual(result.ga4.milestones,[{seconds:60,count:2}]);
  assert.equal(result.ga4.range.timeZone,'Asia/Shanghai');
  assert.equal(result.ga4.range.start,'2026-09-30');
  assert.equal(result.ga4.range.end,'2026-10-27');
  assert.equal(result.ga4.daily[0].date,'2026-10-25');
  assert.equal(result['search-console'].metrics.clicks,0);
  assert.equal(result['search-console'].metadata.latestReportedDate,'2026-10-22');
  assert.equal(result['search-console'].range.end,'2026-10-23');
  const batch = fixture.calls.find(call=>call.url.endsWith(':batchRunReports')).body;
  assert.equal(batch.requests.length,5);
  assert.deepEqual(batch.requests[0].dimensions,[]);
  assert.equal(batch.requests[1].dateRanges[0].startDate,'27daysAgo');
  assert.ok(batch.requests.every(request=>request.dateRanges[0].endDate === 'today'));
  assert.deepEqual(result.ga4.comparison.window,{start:'2026-09-02',end:'2026-09-29',timeZone:'Asia/Shanghai'});
  assert.equal(result.ga4.comparison.metrics.activeUsers,7);
  assert.equal(result.ga4.comparison.metrics.pageViews,15);
  assert.equal(result.ga4.comparison.metrics.engagementRate,0.1);
  const searchCalls = fixture.calls.filter(call=>call.url.endsWith('/searchAnalytics/query'));
  assert.equal(searchCalls.length,5);
  assert.ok(searchCalls.every(call=>call.url.includes('sc-domain%3Aexample.com') && call.body.dataState === 'final'));
  assert.equal(searchCalls.find(call=>call.body.dimensions[0] === 'query').body.rowLimit,10);
  const comparisonCall = searchCalls.find(call=>call.body.startDate === '2026-08-29');
  assert.equal(comparisonCall.body.endDate,'2026-09-25');
  assert.equal(result['search-console'].comparison.window.start,'2026-08-29');
  assert.equal(result['search-console'].comparison.metrics.clicks,0);
  assert.equal(result['search-console'].comparison.metrics.impressions,10);
  assert.ok(!JSON.stringify(result).includes('fixture-provider-access-token'));
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});

test('GA quota failure does not suppress Search Console',async()=>{
  const fixture = fixtureFetch(url=>url.endsWith(':batchRunReports') ? response({error:'fixture-provider-access-token'},429) : null);
  const result = await readGoogle(config(),{now,fetchImpl:fixture.fetchImpl});
  assert.equal(result.ga4.status,'error');
  assert.equal(result.ga4.error.code,'quota');
  assert.equal(result['search-console'].status,'ok');
  assert.ok(!JSON.stringify(result).includes('fixture-provider-access-token'));
});

test('optional realtime, milestone and sitemap errors remain visible without losing core data',async()=>{
  const fixture = fixtureFetch(url=>url.endsWith(':runRealtimeReport') || url.endsWith(':runReport') || url.endsWith('/sitemaps') ? response({},403) : null);
  const result = await readGoogle({...config(),eventConfig:{preset:'lonelysky'}},{now,fetchImpl:fixture.fetchImpl});
  assert.equal(result.ga4.status,'ok');
  assert.equal(result.ga4.metrics.activeUsers,8);
  assert.equal(result.ga4.metrics.realtimeUsers,null);
  assert.equal(result.ga4.metadata.realtimeStatus,'error');
  assert.equal(result.ga4.metadata.optionalErrors.milestones.code,'authorization');
  assert.equal(result['search-console'].status,'ok');
  assert.equal(result['search-console'].metadata.optionalErrors.sitemaps.code,'authorization');
});

test('partial Search Console error leaves missing totals null, not fabricated from top rows',async()=>{
  const fixture = fixtureFetch((url,options)=>url.endsWith('/searchAnalytics/query') && JSON.parse(options.body).dimensions.length === 0 ? response({},503) : null);
  const result = await readGoogle(config(),{now,fetchImpl:fixture.fetchImpl});
  assert.equal(result['search-console'].status,'ok');
  assert.equal(result['search-console'].metrics.clicks,null);
  assert.equal(result['search-console'].metadata.optionalErrors.totals.status,503);
  assert.equal(result.ga4.status,'ok');
});

test('empty successful reports differ from provider failures and missing metric cells',async()=>{
  const fixture = fixtureFetch(url=>url.endsWith('/searchAnalytics/query') ? response({}) : null);
  const result = await readGoogle(config(),{now,fetchImpl:fixture.fetchImpl});
  assert.equal(result['search-console'].status,'empty');
  assert.equal(result['search-console'].metrics.clicks,null);
  assert.equal(result['search-console'].metadata.latestReportedDate,null);
  assert.equal(result.ga4.metrics.realtimeUsers,0);
});

test('Pacific calendar date remains correct across DST, not fixed offset arithmetic',async()=>{
  const first = await readGoogle(config(),{now:new Date('2026-03-09T07:30:00Z'),fetchImpl:fixtureFetch().fetchImpl});
  const second = await readGoogle(config(),{now:new Date('2026-11-02T07:30:00Z'),fetchImpl:fixtureFetch().fetchImpl});
  assert.equal(first['search-console'].range.end,'2026-03-06');
  assert.equal(second['search-console'].range.end,'2026-10-29');
});

test('token is reused server-side while output and auth errors contain no secrets',async()=>{
  const cfg = config();
  const fixture = fixtureFetch();
  await readGoogle(cfg,{now,fetchImpl:fixture.fetchImpl});
  await readGoogle(cfg,{now,fetchImpl:fixture.fetchImpl});
  assert.equal(fixture.calls.filter(call=>call.url.endsWith('/token')).length,1);
  const bad = fixtureFetch(url=>url.endsWith('/token') ? response({error:'fixture-refresh fixture-secret'},400) : null);
  const result = await readGoogle(config(),{now,fetchImpl:bad.fetchImpl});
  assert.equal(result.ga4.status,'error');
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  assert.ok(!JSON.stringify(result).includes('fixture-refresh'));
});

test('service-account JWT uses read-only scopes and standard WebCrypto signature',async()=>{
  const pair = await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const exported = await crypto.subtle.exportKey('pkcs8',pair.privateKey);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(exported).toString('base64')}\n-----END PRIVATE KEY-----`;
  const fixture = fixtureFetch();
  const result = await readGoogle({gaPropertyId:'123456789',searchConsoleSite:'sc-domain:example.com',googleServiceAccount:JSON.stringify({client_email:'fixture@example.iam.gserviceaccount.com',private_key:pem})},{now,fetchImpl:fixture.fetchImpl});
  assert.equal(result.ga4.status,'ok');
  const assertion = new URLSearchParams(fixture.calls.find(call=>call.url.endsWith('/token')).options.body).get('assertion');
  const [header,claims,signature] = assertion.split('.');
  const payload = JSON.parse(Buffer.from(claims,'base64url'));
  assert.equal(payload.aud,'https://oauth2.googleapis.com/token');
  assert.ok(payload.scope.includes('analytics.readonly'));
  assert.ok(payload.scope.includes('webmasters.readonly'));
  assert.equal(payload.exp-payload.iat,3600);
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',pair.publicKey,Buffer.from(signature,'base64url'),new TextEncoder().encode(`${header}.${claims}`)),true);
  assert.ok(!JSON.stringify(result).includes('PRIVATE KEY'));
});

test('Search Console authorization failure leaves GA4 valid and reports safe error',async()=>{
  const fixture = fixtureFetch(url=>url.includes('/webmasters/') ? response({error:'fixture-refresh'},403) : null);
  const result = await readGoogle(config(),{now,fetchImpl:fixture.fetchImpl});
  assert.equal(result.ga4.status,'ok');
  assert.equal(result['search-console'].status,'error');
  assert.equal(result['search-console'].error.code,'authorization');
  assert.ok(!JSON.stringify(result).includes('fixture-refresh'));
});

test('invalid service-account JSON cannot fetch or expose configuration contents',async()=>{
  const result = await readGoogle({gaPropertyId:'123456789',googleServiceAccount:'fixture-private-invalid-json'},{now,fetchImpl:()=>{throw new Error('must not fetch');}});
  assert.equal(result.ga4.status,'error');
  assert.equal(result.ga4.error.code,'configuration');
  assert.equal(result['search-console'].status,'unconfigured');
  assert.ok(!JSON.stringify(result).includes('fixture-private-invalid-json'));
});


test('seven-day traffic report includes today in the property timezone while search retains lag',async()=>{
  const fixture = fixtureFetch();
  const result = await readGoogle(config(),{now:new Date('2026-10-26T17:00:00Z'),days:7,fetchImpl:fixture.fetchImpl});
  const batch = fixture.calls.find(call=>call.url.endsWith(':batchRunReports')).body;
  assert.deepEqual(batch.requests[0].dateRanges,[{startDate:'6daysAgo',endDate:'today'},{startDate:'13daysAgo',endDate:'7daysAgo'}]);
  assert.deepEqual(result.ga4.range,{start:'2026-10-21',end:'2026-10-27',timeZone:'Asia/Shanghai'});
  assert.deepEqual(result.ga4.comparison.window,{start:'2026-10-14',end:'2026-10-20',timeZone:'Asia/Shanghai'});
  assert.equal(result['search-console'].range.end,'2026-10-23');
});


test('official headerless empty realtime response means zero activity without a partial error',async()=>{
  const fixture = fixtureFetch(url=>url.endsWith(':runRealtimeReport') ? response({propertyQuota:{tokensPerHour:{remaining:39121}},kind:'analyticsData#runRealtimeReport'}) : null);
  const result = await readGoogle(config(),{now,fetchImpl:fixture.fetchImpl});
  assert.equal(result.ga4.metrics.realtimeUsers,0);
  assert.deepEqual(result.ga4.realtimeEvents,[]);
  assert.deepEqual(result.ga4.metadata.optionalErrors,{});
  assert.equal(result.ga4.metrics.sessions,12);
});

test('malformed realtime successes remain errors rather than fabricated zero activity',async()=>{
  const malformed = [
    {},
    {kind:'analyticsData#runReport'},
    {kind:'analyticsData#runRealtimeReport',rows:[{metricValues:[{value:'2'}]}]},
    {kind:'analyticsData#runRealtimeReport',rowCount:1},
    {kind:'analyticsData#runRealtimeReport',metricHeaders:[]},
    {metricHeaders:[{name:'activeUsers'}],rows:[{metricValues:[]}]},
    {metricHeaders:[{name:'eventCount'}]},
    {metricHeaders:[{name:'activeUsers'}],rows:{}},
  ];
  for (const body of malformed) {
    const fixture=fixtureFetch(url=>url.endsWith(':runRealtimeReport') ? response(body) : null);
    const result=await readGoogle(config(),{now,fetchImpl:fixture.fetchImpl});
    assert.equal(result.ga4.status,'ok');
    assert.equal(result.ga4.metrics.realtimeUsers,null);
    assert.equal(result.ga4.metadata.optionalErrors.realtime.code,'response');
  }
});


test('official dateRange names select current and previous totals regardless of row order',async()=>{
  const metricNames=['activeUsers','newUsers','sessions','screenPageViews','engagementRate'];
  const cases=[
    {keys:[['date_range_1'],['date_range_0']],values:[['7','2','10','15','0.1'],['8','3','12','18','0']],current:8,previous:7,status:'ok'},
    {keys:[['date_range_0']],values:[['8','3','12','18','0']],current:8,previous:null,status:'ok'},
    {keys:[['date_range_1']],values:[['7','2','10','15','0.1']],current:null,previous:7,status:'empty'},
    {keys:[['unrecognized']],values:[['7','2','10','15','0.1']],current:null,previous:null,status:'empty'},
  ];
  for(const scenario of cases) {
    const fixture=fixtureFetch((url,options)=>{
      if(!url.endsWith(':batchRunReports')) return null;
      const requests=JSON.parse(options.body).requests;
      return response({reports:[report(['dateRange'],metricNames,scenario.values,scenario.keys),...requests.slice(1).map(request=>report(request.dimensions.map(item=>item.name),request.metrics.map(item=>item.name),[]))]});
    });
    const result=await readGoogle(config(),{now,fetchImpl:fixture.fetchImpl});
    assert.equal(result.ga4.status,scenario.status);
    assert.equal(result.ga4.metrics.activeUsers,scenario.current);
    assert.equal(result.ga4.comparison.metrics.activeUsers,scenario.previous);
  }
});

test('historical event values preserve numeric units separately from event counts and missing cells',async()=>{
  const fixture=fixtureFetch((url,options)=>{
    if(!url.endsWith(':batchRunReports')) return null;
    const requests=JSON.parse(options.body).requests;
    return response({reports:requests.map((request,index)=>index===0
      ? report(['dateRange'],request.metrics.map(item=>item.name),[['2','1','2','3','0']],[['date_range_0']])
      : index===4 ? report(['eventName'],['eventCount','eventValue'],[['2','120.5'],['4','2500'],['1','0'],['3'],['1','invalid']],[['flight_time'],['flight_distance'],['zero'],['missing'],['invalid']])
      : report(request.dimensions.map(item=>item.name),request.metrics.map(item=>item.name),[]))});
  });
  const result=await readGoogle(config(),{now,fetchImpl:fixture.fetchImpl});
  assert.deepEqual(result.ga4.events,[{name:'flight_time',count:2,value:120.5},{name:'flight_distance',count:4,value:2500},{name:'zero',count:1,value:0},{name:'missing',count:3,value:null},{name:'invalid',count:1,value:null}]);
  const eventRequest=fixture.calls.find(call=>call.url.endsWith(':batchRunReports')).body.requests[4];
  assert.deepEqual(eventRequest.metrics,[{name:'eventCount'},{name:'eventValue'}]);
});

test('two fixed realtime reads keep unique users and received events separate from history',async()=>{
  const fixture=fixtureFetch((url,options)=>{
    if(!url.endsWith(':runRealtimeReport')) return null;
    const body=JSON.parse(options.body);
    return response(body.dimensions ? report(['eventName'],['eventCount'],[['5'],['7']],[['game_ready'],['flight_time']]) : report([],['activeUsers'],[['4']]));
  });
  const result=await readGoogle(config(),{now,fetchImpl:fixture.fetchImpl});
  assert.equal(result.ga4.metrics.realtimeUsers,4);
  assert.deepEqual(result.ga4.realtimeEvents,[{name:'game_ready',count:5},{name:'flight_time',count:7}]);
  assert.deepEqual(result.ga4.events,[{name:'play_milestone',count:3,value:180}]);
  assert.equal(result.ga4.metadata.realtimeWindowMinutes,30);
  assert.equal(result.ga4.metadata.realtimeStatus,'ok');
  assert.equal(result.ga4.metadata.realtimeEventsStatus,'ok');
  const requests=fixture.calls.filter(call=>call.url.endsWith(':runRealtimeReport')).map(call=>call.body);
  assert.deepEqual(requests,[{metrics:[{name:'activeUsers'}],returnPropertyQuota:true},{dimensions:[{name:'eventName'}],metrics:[{name:'eventCount'}],returnPropertyQuota:true}]);
  assert.equal(result.ga4.realtimeEvents.some(event=>Object.hasOwn(event,'value')),false);
});

test('realtime user and event failures do not suppress the other realtime report',async()=>{
  for(const failEvents of [false,true]) {
    const fixture=fixtureFetch((url,options)=>{
      if(!url.endsWith(':runRealtimeReport')) return null;
      const isEvents=Boolean(JSON.parse(options.body).dimensions);
      return isEvents === failEvents ? response({},400) : response(isEvents ? report(['eventName'],['eventCount'],[['5']],[['game_ready']]) : report([],['activeUsers'],[['4']]));
    });
    const result=await readGoogle(config(),{now,fetchImpl:fixture.fetchImpl});
    assert.equal(result.ga4.status,'ok');
    assert.equal(result.ga4.metrics.realtimeUsers,failEvents ? 4 : null);
    assert.deepEqual(result.ga4.realtimeEvents,failEvents ? [] : [{name:'game_ready',count:5}]);
    assert.equal(result.ga4.metadata.realtimeStatus,failEvents ? 'ok' : 'error');
    assert.equal(result.ga4.metadata.realtimeEventsStatus,failEvents ? 'error' : 'ok');
    assert.equal(result.ga4.metadata.optionalErrors[failEvents ? 'realtimeEvents' : 'realtime'].status,400);
    assert.equal(result.ga4.metadata.optionalErrors[failEvents ? 'realtime' : 'realtimeEvents'],undefined);
  }
});

test('malformed realtime event successes fail independently instead of becoming empty records',async()=>{
  for(const body of [{},{metricHeaders:[{name:'eventCount'}],dimensionHeaders:[],rows:[]},report(['eventName'],['eventCount'],[['invalid']],[['game_ready']])]) {
    const fixture=fixtureFetch((url,options)=>url.endsWith(':runRealtimeReport') && JSON.parse(options.body).dimensions ? response(body) : null);
    const result=await readGoogle(config(),{now,fetchImpl:fixture.fetchImpl});
    assert.equal(result.ga4.metrics.realtimeUsers,0);
    assert.equal(result.ga4.metadata.realtimeStatus,'ok');
    assert.equal(result.ga4.metadata.realtimeEventsStatus,'error');
    assert.equal(result.ga4.metadata.optionalErrors.realtimeEvents.code,'response');
  }
});
