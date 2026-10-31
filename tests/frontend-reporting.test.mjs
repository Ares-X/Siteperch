import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const report = (id, extra = {}) => ({
  id, status:'ok', fetchedAt:'2026-10-31T12:00:00Z',
  range:{start:'2026-10-25',end:'2026-10-31',timeZone:'UTC'},
  metrics:{}, daily:[], pages:[], events:[], channels:[], milestones:[], queries:[],
  ...extra,
});
const ga4 = extra => report('ga4', {
  metrics:{activeUsers:7,pageViews:10,sessions:5,engagementRate:0.5,realtimeUsers:9},
  metadata:{realtimeStatus:'ok'}, pages:[{path:'/ga-only',views:10}],
  daily:[{date:'2026-10-31',activeUsers:7,pageViews:10}], ...extra,
});
const snapshot = (sources, presentation = {}) => ({site:'example.com',days:7,generatedAt:'2026-10-31T12:00:00Z',sources,presentation});

async function dashboard(initial) {
  let next = initial;
  const elements = new Map();
  const app = {innerHTML:'',querySelectorAll:()=>[]};
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {listeners:{},addEventListener(event,handler){this.listeners[event]=handler;},focus(){}});
    return elements.get(selector);
  };
  const context = vm.createContext({
    URL, Intl, Date, console,
    location:{href:'https://private.example/',hash:'',pathname:'/',search:''},
    history:{replaceState(){}}, window:{addEventListener(){},scrollTo(){}},
    document:{querySelector(selector){
      if (selector === '#app') return app;
      return ['#traffic-source','#refresh','#logout'].includes(selector) ? element(selector) : null;
    }},
    async fetch(url) {
      const data = url === '/api/session' ? {configured:true,authenticated:true} : url.startsWith('/api/summary') ? next : {authenticated:false};
      return {ok:true,status:200,json:async()=>data};
    },
  });
  vm.runInContext(code, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('summary?.site',context),'example.com');
  return {
    app,
    evaluate: expression => vm.runInContext(expression,context),
    async refresh(value) { next=value; await vm.runInContext('load()',context); },
    select(value) { element('#traffic-source').listeners.change({target:{value}}); },
  };
}

test('GSC and Bing query failures stay distinct from empty reports while successful zero totals remain visible',async()=>{
  for (const [id,errorKey] of [['search-console','queries'],['bing','GetQueryStats']]) {
    for (const status of [429,403]) {
      const data = report(id,{metrics:{clicks:0,impressions:25,ctr:0},metadata:{optionalErrors:{[errorKey]:{code:status === 429 ? 'quota' : 'authorization',status}}}});
      const ui=await dashboard(snapshot({[id]:data}));
      const html=ui.evaluate(`searchCard('${id}')`);
      assert.match(html,/搜索词读取失败/);
      assert.doesNotMatch(html,/所选时段暂无可用搜索词数据/);
      assert.match(html,/<span class="value">0<\/span>/);
      assert.match(html,/<span class="value">25<\/span>/);
    }
  }
});

test('successful empty queries and a returned zero-click query are rendered differently',async()=>{
  for (const id of ['search-console','bing']) {
    const data=report(id,{metrics:{clicks:0,impressions:10},metadata:{optionalErrors:{}}});
    const ui=await dashboard(snapshot({[id]:data}));
    assert.match(ui.evaluate(`searchCard('${id}')`),/所选时段暂无可用搜索词数据/);
    await ui.refresh(snapshot({[id]:{...data,queries:[{query:'zero-click query',clicks:0,impressions:10}]}}));
    const html=ui.evaluate(`searchCard('${id}')`);
    assert.match(html,/zero-click query/);
    assert.match(html,/<td>0<\/td>/);
    assert.doesNotMatch(html,/搜索词读取失败|所选时段暂无可用搜索词数据/);
  }
});

test('valid realtime values survive an empty historical aggregate without fabricating historical totals',async()=>{
  for (const value of [9,0]) {
    const ui=await dashboard(snapshot({ga4:ga4({status:'empty',metrics:{activeUsers:null,pageViews:null,realtimeUsers:value}})}));
    assert.equal(ui.evaluate("metric(source('ga4'),'realtimeUsers')"),value);
    assert.equal(ui.evaluate("metric(source('ga4'),'activeUsers')"),undefined);
    assert.match(ui.app.innerHTML,new RegExp(`近 30 分钟 ${value} 位活跃用户`));
    assert.doesNotMatch(ui.app.innerHTML,/活跃人数未提供|活跃人数读取失败/);
  }
});

test('realtime failures, old snapshots, and legacy numeric successes retain their own meanings',async()=>{
  const ui=await dashboard(snapshot({ga4:ga4({status:'empty',metrics:{realtimeUsers:null},metadata:{realtimeStatus:'error',optionalErrors:{realtime:{code:'network'}}}})}));
  assert.match(ui.app.innerHTML,/近 30 分钟活跃人数读取失败/);
  await ui.refresh(snapshot({ga4:ga4({status:'stale'})}));
  assert.match(ui.app.innerHTML,/上次快照：近 30 分钟 9 位活跃用户/);
  await ui.refresh(snapshot({ga4:ga4({status:'empty',metadata:{}})}));
  assert.equal(ui.evaluate("metric(source('ga4'),'realtimeUsers')"),9);
  await ui.refresh(snapshot({ga4:ga4({metadata:{optionalErrors:{realtime:{code:'network'}}}})}));
  assert.equal(ui.evaluate("metric(source('ga4'),'realtimeUsers')"),undefined);
  assert.match(ui.app.innerHTML,/近 30 分钟活跃人数读取失败/);
});

test('GA quality metadata appears beside the affected report and upstream text is escaped',async()=>{
  const reports=[
    {samplingMetadatas:[{samplesReadCount:'100',samplingSpaceSize:'1000'}]},
    {subjectToThresholding:true},
    {dataLossFromOtherRow:true},
    {emptyReason:'<script>restricted-report</script>'},
    {samplingMetadatas:[{samplesReadCount:'1',samplingSpaceSize:'2'}]},
  ];
  const ui=await dashboard(snapshot({ga4:ga4({metadata:{realtimeStatus:'ok',reports},events:[{name:'download',count:4}]})}));
  const totals=ui.evaluate('metricsStrip()');
  assert.match(totals,/采样读取比例：10%/);
  assert.doesNotMatch(totals,/数据阈值|\(other\)/);
  const daily=ui.evaluate('trafficCard()');
  assert.match(daily,/可能受数据阈值影响/);
  assert.match(daily,/不表示一定隐藏了数据/);
  assert.doesNotMatch(daily,/采样读取比例：10%/);
  assert.match(ui.evaluate('pagesCard()'),/归入 \(other\)/);
  assert.match(ui.evaluate('eventsCard(true)'),/采样读取比例：50%/);
  const events=ui.evaluate('gameView()');
  assert.match(events,/空报表原因：&lt;script&gt;restricted-report&lt;\/script&gt;/);
  assert.doesNotMatch(events,/<script>/);
  const sources=ui.evaluate('sourceView()');
  assert.match(sources,/采样读取比例：10%/);
  assert.match(sources,/可能受数据阈值影响/);
});

test('ordinary complete GA reports do not receive quality warnings',async()=>{
  const reports=[{subjectToThresholding:false,dataLossFromOtherRow:false,emptyReason:'',samplingMetadatas:[{samplesReadCount:'10',samplingSpaceSize:'10'}]},{},{},{},{}];
  const ui=await dashboard(snapshot({ga4:ga4({metadata:{realtimeStatus:'ok',reports}})}));
  assert.doesNotMatch(ui.app.innerHTML,/report-quality/);
  assert.doesNotMatch(ui.evaluate('sourceView()'),/report-quality/);
});

test('generic events use their original names, including events beyond the old first 30 rows',async()=>{
  const events=[{name:'download',count:25},{name:'sign_up',count:10},{name:'purchase',count:4},...Array.from({length:40},(_,index)=>({name:`custom_event_${index}`,count:1}))];
  const ui=await dashboard(snapshot({ga4:ga4({events,milestones:[{seconds:60,count:12}]})}));
  const full=ui.evaluate('eventsCard(true)');
  for (const name of ['download','sign_up','purchase','custom_event_39']) assert.match(full,new RegExp(name));
  assert.doesNotMatch(full,/航行|游戏|里程碑|独立玩家/);
  assert.match(ui.evaluate('eventsCard()'),/显示 5 \/ 43 个可见事件项/);
});

test('event labels, groups, ordering and hiding are applied without executing configuration text',async()=>{
  const events=[{name:'download',count:0},{name:'purchase',count:4},{name:'sign_up',count:10},{name:'constructor',count:1}];
  const presentation={events:{preset:'generic',definitions:{
    download:{label:'<img onerror="bad">下载',group:'<互动>',order:20},
    sign_up:{label:'注册',group:'<互动>',order:10},
    purchase:{hidden:true},
  }}};
  const ui=await dashboard(snapshot({ga4:ga4({events})},presentation));
  const html=ui.evaluate("eventRows(source('ga4'),true)");
  assert.match(html,/constructor/);
  assert.match(html,/&lt;互动&gt;/);
  assert.match(html,/&lt;img onerror=&quot;bad&quot;&gt;下载/);
  assert.ok(html.indexOf('注册') < html.indexOf('下载'));
  assert.match(html,/<span>0<\/span>/);
  assert.doesNotMatch(html,/purchase|<img|<互动>/);
});

test('LonelySky milestones require the preset and respect hiding while preserving unrelated events',async()=>{
  const data=ga4({events:[{name:'game_ready',count:10},{name:'play_milestone',count:999},{name:'download',count:4}],milestones:[{seconds:60,count:8},{seconds:300,count:3}]});
  const presentation={events:{preset:'lonelysky',definitions:{game_ready:{label:'游戏就绪',order:1},play_milestone:{label:'航行里程碑',order:2}}}};
  const ui=await dashboard(snapshot({ga4:data},presentation));
  const html=ui.evaluate('eventsCard(true)');
  assert.match(html,/游戏就绪/);
  assert.match(html,/航行里程碑 · 1 分钟/);
  assert.match(html,/航行里程碑 · 5 分钟/);
  assert.match(html,/download/);
  assert.doesNotMatch(html,/999/);
  await ui.refresh(snapshot({ga4:data},{events:{preset:'generic',definitions:{}}}));
  assert.match(ui.evaluate('eventsCard(true)'),/play_milestone/);
  assert.doesNotMatch(ui.evaluate('eventsCard(true)'),/航行里程碑/);
  presentation.events.definitions.play_milestone.hidden=true;
  await ui.refresh(snapshot({ga4:data},presentation));
  assert.doesNotMatch(ui.evaluate("eventRows(source('ga4'),true)"),/航行里程碑|play_milestone|999/);
});

test('intentionally hidden events are not reported as missing upstream data',async()=>{
  const ui=await dashboard(snapshot({ga4:ga4({events:[{name:'download',count:0}]})},{events:{preset:'generic',definitions:{download:{hidden:true}}}}));
  const html=ui.evaluate('eventsCard(true)');
  assert.match(html,/事件已隐藏/);
  assert.doesNotMatch(html,/所选时段暂无可用事件数据/);
});

test('overview defaults to a configured source and honors an explicit choice even if it is unavailable',async()=>{
  const cf=report('cloudflare',{metrics:{visits:123,pageViews:456},pages:[{path:'/cf-only',views:456}]});
  const vercel=report('vercel',{metrics:{visitors:77,pageViews:88},pages:[{path:'/vercel-only',views:88}]});
  const cases=[
    [snapshot({cloudflare:cf}),'cloudflare','访问次数','/cf-only'],
    [snapshot({vercel}),'vercel','独立访客','/vercel-only'],
    [snapshot({ga4:ga4({status:'error'}),cloudflare:cf}),'ga4','活跃用户',null],
    [snapshot({ga4:ga4(),cloudflare:cf},{primarySource:'cloudflare'}),'cloudflare','访问次数','/cf-only'],
    [snapshot({cloudflare:cf},{primarySource:'ga4'}),'ga4','活跃用户',null],
  ];
  for (const [data,id,label,path] of cases) {
    const ui=await dashboard(data);
    assert.equal(ui.evaluate('traffic'),id);
    const strip=ui.evaluate('metricsStrip()');
    assert.match(strip,new RegExp(label));
    if(id === 'cloudflare') assert.doesNotMatch(strip,/活跃用户|独立访客|会话数|互动率/);
    if(path) assert.match(ui.evaluate('pagesCard()'),new RegExp(path));
  }
});

test('manual source selection updates overview metrics, trend and pages together and survives refresh',async()=>{
  const data=snapshot({ga4:ga4(),cloudflare:report('cloudflare',{metrics:{visits:123,pageViews:456},pages:[{path:'/cf-only',views:456}],daily:[{date:'2026-10-31',visits:123,pageViews:456}]})},{primarySource:'ga4'});
  const ui=await dashboard(data);
  ui.select('cloudflare');
  assert.equal(ui.evaluate('traffic'),'cloudflare');
  assert.match(ui.evaluate('metricsStrip()'),/访问次数/);
  assert.match(ui.evaluate('trafficCard()'),/Cloudflare 每日趋势/);
  assert.match(ui.evaluate('pagesCard()'),/\/cf-only/);
  assert.doesNotMatch(ui.evaluate('pagesCard()'),/\/ga-only/);
  assert.match(ui.evaluate('gameView()'),/Google Analytics 核心指标/);
  await ui.refresh(data);
  assert.equal(ui.evaluate('traffic'),'cloudflare');
  ui.select('constructor');
  assert.equal(ui.evaluate('traffic'),'cloudflare');
});

test('Cloudflare and Vercel overview partial errors remain failures and preserve source caveats',async()=>{
  for (const [id,dailyKey,pagesKey] of [['cloudflare','daily','pages'],['vercel','day','requestPath']]) {
    const data=report(id,{
      metrics:{visits:12,visitors:12,pageViews:34},
      metadata:{optionalErrors:{[dailyKey]:{code:'quota',status:429},[pagesKey]:{code:'coverage'}}},
      note:'此报表可能抽样；采样间隔 10。<script>source-note</script>',
    });
    const ui=await dashboard(snapshot({[id]:data}));
    const trend=ui.evaluate('trafficCard()'), pages=ui.evaluate('pagesCard()');
    assert.match(trend,/趋势数据读取失败/);
    assert.doesNotMatch(trend,/所选时段暂无可用趋势数据/);
    assert.match(pages,/页面数据读取失败/);
    assert.doesNotMatch(pages,/所选时段暂无可用页面数据/);
    assert.match(trend,/此报表可能抽样；采样间隔 10/);
    assert.match(trend,/&lt;script&gt;source-note&lt;\/script&gt;/);
    assert.doesNotMatch(trend,/<script>/);
    assert.match(ui.evaluate('metricsStrip()'),/>34<\/div>/);
    await ui.refresh(snapshot({[id]:{...data,pages:[{path:'/partial-page',views:4}],daily:[{date:'2026-10-31',pageViews:4}]}}));
    assert.match(ui.evaluate('pagesCard()'),/\/partial-page/);
    assert.match(ui.evaluate('pagesCard()'),/页面数据读取失败/);
    assert.match(ui.evaluate('trafficCard()'),/查看每日数据/);
  }
});

test('presentation configuration notices are visible and escaped',async()=>{
  const ui=await dashboard(snapshot({ga4:ga4()},{warnings:['配置无效，使用默认值。','<script>warning</script>']}));
  assert.match(ui.app.innerHTML,/配置无效，使用默认值/);
  assert.match(ui.app.innerHTML,/&lt;script&gt;warning&lt;\/script&gt;/);
  assert.doesNotMatch(ui.app.innerHTML,/<script>/);
});
