import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createHandler} from '../server/handler.js';
import {createDashboard} from '../server/dashboard.js';
import {authenticated,sessionCookie} from '../server/auth.js';
import {requestJSON,ProviderError} from '../server/common.js';
const password='Owner-test-password-with-high-entropy-123';
const env={DASHBOARD_PASSWORD_SHA256:createHash('sha256').update(password).digest('hex'),DASHBOARD_SESSION_SECRET:'session-signing-secret-that-is-long-enough-123',APP_ORIGIN:'https://observatory.example'};
const now=new Date('2026-10-27T08:00:00Z');
const request=(path,options={})=>new Request('https://observatory.example/api/'+path,options);
const login=(origin='https://observatory.example',value=password)=>request('login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:value})});
async function ownerCookie(){return (await sessionCookie(request('session'),env,now)).split(';')[0];}

test('unconfigured and unauthenticated backends never fetch private provider data',async()=>{
  let reads=0;
  const dashboard={read:async()=>{reads++;return{};}};
  const handler=createHandler(env,{now:()=>now,dashboard});
  assert.equal((await handler(request('summary'))).status,401);
  assert.deepEqual(await(await handler(request('session'))).json(),{authenticated:false,configured:true});
  const off=createHandler({}, {dashboard});
  assert.equal((await off(request('summary'))).status,503);
  assert.deepEqual(await(await off(request('session'))).json(),{authenticated:false,configured:false});
  assert.equal(reads,0);
});

test('retained provider tokens without site identifiers cannot query a former owner site',async()=>{
  let reads=0;
  const handler=createHandler({...env,VERCEL_ANALYTICS_TOKEN:'fixture-vercel',CLOUDFLARE_ANALYTICS_TOKEN:'fixture-cf',BING_WEBMASTER_API_KEY:'fixture-bing'}, {now:()=>now,fetchImpl:async()=>{reads++;throw Error('unexpected provider request');}});
  const response=await handler(request('summary',{headers:{Cookie:await ownerCookie()}}));
  assert.equal(response.status,200);
  const summary=await response.json();
  assert.equal(summary.site,'');
  assert.equal(reads,0);
  for(const source of Object.values(summary.sources)) assert.equal(source.status,'unconfigured');
});

test('owner login sets a secure HttpOnly session and private data is never publicly cacheable',async()=>{
  const handler=createHandler(env,{now:()=>now,dashboard:{read:async days=>({days,site:'example.com'})}});
  const response=await handler(login());assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie');
  assert.match(cookie,/^__Host-observatory=/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,/Secure/);
  assert.doesNotMatch(cookie,new RegExp(password));
  const summary=await handler(request('summary?days=28',{headers:{Cookie:cookie.split(';')[0]}}));
  assert.equal(summary.status,200);assert.equal((await summary.json()).days,28);
  assert.match(summary.headers.get('cache-control'),/no-store/);assert.equal(summary.headers.get('access-control-allow-origin'),null);
});

test('invalid password, origin, method and excessive body fail at the login boundary',async()=>{
  const handler=createHandler(env,{now:()=>now});
  assert.equal((await handler(login('https://evil.example'))).status,403);
  assert.equal((await handler(login('https://observatory.example','not-the-password'))).status,401);
  assert.equal((await handler(request('login'))).status,405);
  assert.equal((await handler(request('login',{method:'POST',headers:{Origin:env.APP_ORIGIN,'Content-Type':'text/plain'},body:password}))).status,415);
  assert.equal((await handler(request('login',{method:'POST',headers:{Origin:env.APP_ORIGIN,'Content-Type':'application/json'},body:'x'.repeat(2050)}))).status,413);
});

test('owner-selected passwords below 16 characters match exactly and rotate existing sessions',async()=>{
  const chosen='Owner!24680';
  const changed={...env,DASHBOARD_PASSWORD_SHA256:createHash('sha256').update(chosen).digest('hex')};
  const handler=createHandler(changed,{now:()=>now});
  assert.equal((await handler(login(env.APP_ORIGIN,chosen))).status,200);
  for (const value of [password,'',null,chosen+' ',chosen.toLowerCase(),'x'.repeat(257)]) {
    assert.equal((await handler(login(env.APP_ORIGIN,value))).status,401);
  }
  assert.equal(await authenticated(request('session',{headers:{Cookie:await ownerCookie()}}),changed,now),false);
});

test('forged, expired and password-rotated sessions are rejected',async()=>{
  const cookie=await ownerCookie();
  assert.equal(await authenticated(request('session',{headers:{Cookie:cookie}}),env,now),true);
  assert.equal(await authenticated(request('session',{headers:{Cookie:cookie+'bad'}}),env,now),false);
  assert.equal(await authenticated(request('session',{headers:{Cookie:cookie}}),env,new Date(now.getTime()+8*3600000)),false);
  assert.equal(await authenticated(request('session',{headers:{Cookie:cookie}}),{...env,DASHBOARD_PASSWORD_SHA256:'b'.repeat(64)},now),false);
});

test('logout requires own origin and authenticated cookie; unsupported ranges never query',async()=>{
  const cookie=await ownerCookie();let reads=0;
  const handler=createHandler(env,{now:()=>now,dashboard:{read:()=>{reads++;}}});
  assert.equal((await handler(request('summary?days=365',{headers:{Cookie:cookie}}))).status,400);
  assert.equal((await handler(request('logout',{method:'POST',headers:{Origin:'https://evil.example',Cookie:cookie}}))).status,403);
  const response=await handler(request('logout',{method:'POST',headers:{Origin:env.APP_ORIGIN,Cookie:cookie}}));
  assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/Max-Age=0/);assert.equal(reads,0);
});

test('dashboard fan-out keeps independent failures visible and unconfigured is not zero traffic',async()=>{
  const source=id=>({id,status:'ok',metrics:{pageViews:0},fetchedAt:now.toISOString()});
  const providers={readGoogle:async()=>({ga4:source('ga4'),'search-console':{id:'search-console',status:'unconfigured'}}),readCloudflare:async()=>{throw new ProviderError('authorization','授权无效。',403);},readVercel:async()=>source('vercel'),readBing:async()=>({id:'bing',status:'empty'})};
  const result=await createDashboard(env,{providers,now:()=>now}).read(7);
  assert.equal(result.sources.ga4.metrics.pageViews,0);
  assert.equal(result.sources['search-console'].metrics,undefined);
  assert.equal(result.sources.cloudflare.status,'error');assert.equal(result.sources.vercel.status,'ok');
});

test('warm cache deduplicates reads and retains dated last-good data after a failed refresh',async()=>{
  let time=new Date(now),calls=0,fail=false;
  const ok=id=>({id,status:'ok',metrics:{pageViews:4},fetchedAt:time.toISOString()});
  const providers={readGoogle:async()=>{calls++;return {ga4:ok('ga4'),'search-console':ok('search-console')};},readCloudflare:async()=>{if(fail)throw Error('private-url-token');return ok('cloudflare');},readVercel:async()=>ok('vercel'),readBing:async()=>ok('bing')};
  const dashboard=createDashboard(env,{providers,now:()=>time});
  await Promise.all([dashboard.read(7),dashboard.read(7)]);assert.equal(calls,1);
  assert.equal((await dashboard.read(7)).cache.hit,true);
  time=new Date(now.getTime()+301000);fail=true;
  const result=await dashboard.read(7);
  assert.equal(result.sources.cloudflare.status,'stale');assert.equal(result.sources.cloudflare.fetchedAt,now.toISOString());
  assert.doesNotMatch(JSON.stringify(result),/private-url-token/);assert.equal(result.sources.ga4.status,'ok');
});

test('upstream credentials and URLs stay out of safe failures while incident cause remains inspectable',async()=>{
  const cause=Error('https://private.example/?apikey=secret');let error;
  try{await requestJSON('https://private.example/?apikey=secret',{fetchImpl:async()=>{throw cause;}});}catch(e){error=e;}
  assert.equal(error.cause,cause);assert.equal(error.code,'network');
  assert.doesNotMatch(JSON.stringify({code:error.code,message:error.message}),/private|apikey|secret/);
});
