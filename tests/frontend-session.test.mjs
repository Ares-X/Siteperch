import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const snapshot = value => ({site:'example.com',days:7,sources:{ga4:{id:'ga4',status:'ok',metrics:{activeUsers:value}}}});
const response = (data, ok = true, status = 200) => ({ok,status,json:async()=>data});
const deferred = () => { let resolve; const promise = new Promise(done => {resolve=done;}); return {promise,resolve}; };

async function dashboard(logoutResponse) {
  const pending = deferred();
  let reads = 0;
  let logouts = 0;
  const elements = new Map();
  const app = {innerHTML:'',querySelectorAll:()=>[]};
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector,{disabled:false,listeners:{},addEventListener(event,handler){this.listeners[event]=handler;},focus(){}});
    return elements.get(selector);
  };
  const context = vm.createContext({
    URL, Intl, Date, console,
    location:{href:'https://private.example/',hash:'',pathname:'/',search:''},
    history:{replaceState(){}}, window:{addEventListener(){}},
    document:{querySelector(selector){
      if(selector==='#app') return app;
      if(['#logout','#refresh'].includes(selector)) return element(selector);
      return null;
    }},
    async fetch(url){
      if(url==='/api/session') return response({configured:true,authenticated:true});
      if(url==='/api/logout') {logouts++; return logoutResponse(logouts);}
      if(url.startsWith('/api/summary')) {reads++; return reads===2 ? pending.promise : response(snapshot(reads===1 ? 101 : 303));}
      throw Error(`Unexpected request ${url}`);
    },
  });
  vm.runInContext(code,context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(app.innerHTML,/101/);
  const loading = vm.runInContext('load()',context);
  assert.equal(reads,2);
  const logout = () => element('#logout').listeners.click({currentTarget:element('#logout')});
  return {context,app,pending,loading,logout,reads:()=>reads};
}

test('a pending private summary cannot restore the dashboard after successful logout',async()=>{
  const ui=await dashboard(()=>response({authenticated:false}));
  await ui.logout();
  assert.match(ui.app.innerHTML,/访问你的观测台/);
  ui.pending.resolve(response(snapshot(987654)));
  await ui.loading;
  assert.match(ui.app.innerHTML,/访问你的观测台/);
  assert.doesNotMatch(ui.app.innerHTML,/987,654|访问总览/);
  assert.equal(vm.runInContext('summary',ui.context),undefined);
});

test('failed logout allows a fresh refresh and retry; its old pending load remains invalid',async()=>{
  const ui=await dashboard(attempt=>attempt===1 ? response({},false,503) : response({authenticated:false}));
  await ui.logout();
  assert.match(ui.app.innerHTML,/暂时无法退出/);
  await vm.runInContext('load()',ui.context);
  assert.equal(ui.reads(),3);
  assert.match(ui.app.innerHTML,/303/);
  ui.pending.resolve(response(snapshot(987654)));
  await ui.loading;
  assert.match(ui.app.innerHTML,/303/);
  assert.doesNotMatch(ui.app.innerHTML,/987,654/);
  await ui.logout();
  assert.match(ui.app.innerHTML,/访问你的观测台/);
});

test('overview metrics fall back to a configured traffic source when GA4 is absent',async()=>{
  const elements=new Map();
  const app={innerHTML:'',querySelectorAll:()=>[]};
  const element=selector=>{
    if(!elements.has(selector)) elements.set(selector,{disabled:false,listeners:{},addEventListener(event,handler){this.listeners[event]=handler;},focus(){}});
    return elements.get(selector);
  };
  const context=vm.createContext({
    URL,Intl,Date,console,
    location:{href:'https://private.example/',hash:'',pathname:'/',search:''},
    history:{replaceState(){}},window:{addEventListener(){}},
    document:{querySelector(selector){
      if(selector==='#app') return app;
      if(['#logout','#refresh'].includes(selector)) return element(selector);
      return null;
    }},
    async fetch(url){
      if(url==='/api/session') return response({configured:true,authenticated:true});
      if(url.startsWith('/api/summary')) return response({site:'example.com',days:7,sources:{
        ga4:{id:'ga4',status:'unconfigured'},
        vercel:{id:'vercel',status:'ok',metrics:{visitors:42,pageViews:99}},
      }});
      throw Error(`Unexpected request ${url}`);
    },
  });
  vm.runInContext(code,context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(app.innerHTML,/独立访客/);
  assert.match(app.innerHTML,/Vercel · 已同步/);
  assert.match(app.innerHTML,/aria-label="Vercel 核心指标"/);
  assert.doesNotMatch(app.innerHTML,/GA4 · 已同步/);
});

async function renderSummary(summary, extraContext = {}) {
  const elements = new Map();
  const app = {innerHTML:'',querySelectorAll:()=>[]};
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector,{disabled:false,listeners:{},addEventListener(event,handler){this.listeners[event]=handler;},focus(){}});
    return elements.get(selector);
  };
  const context = vm.createContext({
    URL, Intl, Date, console,
    location:{href:'https://private.example/',hash:'',pathname:'/',search:''},
    history:{replaceState(){}}, window:{addEventListener(){}},
    document:{querySelector(selector){
      if (selector === '#app') return app;
      if (['#logout','#refresh'].includes(selector)) return element(selector);
      return null;
    }},
    async fetch(url){
      if (url === '/api/session') return response({configured:true,authenticated:true});
      if (url.startsWith('/api/summary')) return response(summary);
      throw Error(`Unexpected request ${url}`);
    },
    ...extraContext,
  });
  vm.runInContext(code,context);
  await new Promise(resolve=>setImmediate(resolve));
  return {context,app};
}

test('charts render per-day hit areas, cursor and focus marks for interaction',async()=>{
  const daily = Array.from({length:7},(_,index)=>{const day=new Date(Date.UTC(2026,9,21+index));return {date:day.toISOString().slice(0,10),pageViews:100+index,activeUsers:index===3?null:10+index};});
  const {app} = await renderSummary({site:'example.com',days:7,sources:{ga4:{id:'ga4',status:'ok',metrics:{pageViews:700},range:{start:'2026-10-21',end:'2026-10-27',timeZone:'UTC'},daily}}});
  assert.equal((app.innerHTML.match(/class="chart-hit"/g)||[]).length,7);
  assert.equal((app.innerHTML.match(/class="chart-focus"/g)||[]).length,2);
  assert.match(app.innerHTML,/data-series='\[&quot;页面浏览&quot;,&quot;活跃用户&quot;\]'/);
  assert.match(app.innerHTML,/class="chart-readout" data-hint="[^"]+" aria-live="polite"/);
  assert.match(app.innerHTML,/class="chart" viewBox="0 0 650 284" role="img" tabindex="0"/);
  const missing = app.innerHTML.match(/data-date="2026-10-24" data-values="103,"/);
  assert.ok(missing);
});

test('chart wiring answers hover and arrow keys with the exact day values',async()=>{
  const node = (dataset = {}) => ({dataset,attributes:{},listeners:{},textContent:'',setAttribute(key,value){this.attributes[key]=value;},getAttribute(key){return this.attributes[key] ?? null;},addEventListener(event,handler){this.listeners[event]=handler;}});
  const hits = [
    node({date:'2026-10-21',values:'100,',x:'45.0',y0:'250.0'}),
    node({date:'2026-10-22',values:'200,20',x:'145.0',y0:'200.0',y1:'150.0'}),
    node({date:'2026-10-23',values:'150,15',x:'245.0',y0:'220.0',y1:'160.0'}),
  ];
  const cursor = node(), focus = [node(),node()], readout = node({hint:'提示文案'});
  const svg = {
    attributes:{'data-series':'["页面浏览","活跃用户"]'},
    listeners:{},
    addEventListener(event,handler){this.listeners[event]=handler;},
    getAttribute(key){return this.attributes[key];},
    querySelector:selector=>selector === '.chart-cursor' ? cursor : null,
    querySelectorAll:selector=>selector === '.chart-hit' ? hits : selector === '.chart-focus' ? focus : [],
  };
  const {context} = await renderSummary({site:'example.com',days:7,sources:{ga4:{id:'ga4',status:'ok'}}},{__svg:svg,__readout:readout});
  vm.runInContext('wireChart(__svg,__readout)',context);
  hits[1].listeners.pointerenter();
  assert.equal(readout.textContent,'2026-10-22 · 页面浏览 200 · 活跃用户 20');
  assert.equal(cursor.attributes.x1,'145.0'); assert.equal(cursor.attributes.visibility,'visible');
  assert.equal(focus[0].attributes.cx,'145.0'); assert.equal(focus[1].attributes.visibility,'visible');
  svg.listeners.keydown({key:'ArrowLeft',preventDefault(){}});
  assert.equal(readout.textContent,'2026-10-21 · 页面浏览 100 · 活跃用户 —');
  assert.equal(focus[1].attributes.visibility,'hidden');
  svg.listeners.keydown({key:'End',preventDefault(){}});
  assert.equal(readout.textContent,'2026-10-23 · 页面浏览 150 · 活跃用户 15');
  svg.listeners.blur();
  assert.equal(readout.textContent,'提示文案'); assert.equal(cursor.attributes.visibility,'hidden');
});

test('metric deltas render only for comparable positive previous values',async()=>{
  const elements=new Map();
  const app={innerHTML:'',querySelectorAll:()=>[]};
  const element=selector=>{
    if(!elements.has(selector)) elements.set(selector,{disabled:false,listeners:{},addEventListener(event,handler){this.listeners[event]=handler;},focus(){}});
    return elements.get(selector);
  };
  const context=vm.createContext({
    URL,Intl,Date,console,
    location:{href:'https://private.example/',hash:'',pathname:'/',search:''},
    history:{replaceState(){}},window:{addEventListener(){}},
    document:{querySelector(selector){
      if(selector==='#app') return app;
      if(['#logout','#refresh'].includes(selector)) return element(selector);
      return null;
    }},
    async fetch(url){
      if(url==='/api/session') return response({configured:true,authenticated:true});
      if(url.startsWith('/api/summary')) return response({site:'example.com',days:7,sources:{
        ga4:{id:'ga4',status:'ok',metrics:{activeUsers:200,pageViews:1000,sessions:300,engagementRate:.5},
             comparison:{window:{start:'2026-10-14',end:'2026-10-20',timeZone:'UTC'},
                         metrics:{activeUsers:100,pageViews:800,sessions:null,engagementRate:.6}}},
      }});
      throw Error(`Unexpected request ${url}`);
    },
  });
  vm.runInContext(code,context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(app.innerHTML,/▲ 100%/);
  assert.match(app.innerHTML,/▲ 25%/);
  assert.match(app.innerHTML,/▼ 16\.7%/);
  assert.match(app.innerHTML,/较上 7 天/);
  const sessions=app.innerHTML.match(/会话数<\/div><div class="metric-value">[^<]*<\/div><div class="metric-foot">([^<]*)/);
  assert.ok(sessions); assert.doesNotMatch(sessions[1],/▲|▼/);
});

test('source drawer exposes the comparison window and GA4 token quota',async()=>{
  const elements=new Map();
  const app={innerHTML:'',querySelectorAll:()=>[]};
  const element=selector=>{
    if(!elements.has(selector)) elements.set(selector,{disabled:false,listeners:{},addEventListener(event,handler){this.listeners[event]=handler;},focus(){}});
    return elements.get(selector);
  };
  const overlays=[];
  const fakeElement=()=>({className:'',innerHTML:'',querySelector:()=>({focus(){},addEventListener(){}}),addEventListener(){},remove(){}});
  const context=vm.createContext({
    URL,Intl,Date,console,
    location:{href:'https://private.example/',hash:'',pathname:'/',search:''},
    history:{replaceState(){}},window:{addEventListener(){}},
    document:{
      querySelector(selector){
        if(selector==='#app') return app;
        if(['#logout','#refresh'].includes(selector)) return element(selector);
        return null;
      },
      createElement:()=>fakeElement(),
      addEventListener(){},removeEventListener(){},
      body:{append(overlay){overlays.push(overlay);}},
    },
    async fetch(url){
      if(url==='/api/session') return response({configured:true,authenticated:true});
      if(url.startsWith('/api/summary')) return response({site:'example.com',days:7,sources:{
        ga4:{id:'ga4',status:'ok',metrics:{},
             comparison:{window:{start:'2026-10-14',end:'2026-10-20',timeZone:'Asia/Shanghai'},metrics:{}},
             metadata:{propertyQuota:{tokensPerHour:{consumed:'40',remaining:39121},tokensPerDay:{consumed:'500',remaining:142000}}}},
      }});
      throw Error(`Unexpected request ${url}`);
    },
  });
  vm.runInContext(code,context);
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext("showSource('ga4',{focus(){}})",context);
  assert.equal(overlays.length,1);
  assert.match(overlays[0].innerHTML,/环比参考期/);
  assert.match(overlays[0].innerHTML,/2026-10-14 — 2026-10-20 · Asia\/Shanghai/);
  assert.match(overlays[0].innerHTML,/GA4 配额/);
  assert.match(overlays[0].innerHTML,/近 1 小时已用 40 · 剩余 39,121 tokens/);
  assert.match(overlays[0].innerHTML,/近 24 小时已用 500 · 剩余 142,000 tokens/);
});
