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
