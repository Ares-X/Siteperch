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
const loginFrom=(ip,value=password,origin='https://observatory.example')=>[login(origin,value),ip];
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

test('oversized streamed logins stop reading even with a forged length and pending cancellation',{timeout:2000},async()=>{
  const handler=createHandler(env,{now:()=>now});
  for (const extraHeaders of [{},{'Content-Length':'1'}]) {
    let produced=0,cancelled=false;
    const stream=new ReadableStream({
      pull(controller) {
        produced+=512;
        controller.enqueue(new Uint8Array(512));
        if (produced===1024*1024) controller.close();
      },
      cancel() { cancelled=true; return new Promise(()=>{}); },
    },{highWaterMark:0});
    const response=await handler(request('login',{method:'POST',headers:{Origin:env.APP_ORIGIN,'Content-Type':'application/json',...extraHeaders},body:stream,duplex:'half'}));
    assert.equal(response.status,413);
    assert.equal(cancelled,true);
    assert.ok(produced<=3072,`read too far into oversized body: ${produced} bytes`);
    assert.match(response.headers.get('cache-control'),/no-store/);
  }
});

test('an oversized declared login body is cancelled before any reads',async()=>{
  let pulls=0,cancelled=false;
  const stream=new ReadableStream({pull(){pulls++;},cancel(){cancelled=true;}},{highWaterMark:0});
  const handler=createHandler(env,{now:()=>now});
  const response=await handler(request('login',{method:'POST',headers:{Origin:env.APP_ORIGIN,'Content-Type':'application/json','Content-Length':'1048576'},body:stream,duplex:'half'}));
  assert.equal(response.status,413);
  assert.equal(pulls,0);
  assert.equal(cancelled,true);
});

test('login body limit counts UTF-8 bytes and accepts the exact boundary across split characters',async()=>{
  const handler=createHandler(env,{now:()=>now});
  const overhead=Buffer.byteLength(JSON.stringify({password,padding:''}));
  const room=2048-overhead;
  const padding='界'.repeat(Math.floor(room/3))+'x'.repeat(room%3);
  const bytes=new TextEncoder().encode(JSON.stringify({password,padding}));
  assert.equal(bytes.byteLength,2048);
  let offset=0;
  const stream=new ReadableStream({pull(controller){
    if (offset===bytes.length) {controller.close();return;}
    controller.enqueue(bytes.slice(offset,offset+7));offset=Math.min(bytes.length,offset+7);
  }},{highWaterMark:0});
  const response=await handler(request('login',{method:'POST',headers:{Origin:env.APP_ORIGIN,'Content-Type':'application/json'},body:stream,duplex:'half'}));
  assert.equal(response.status,200);
  assert.match(response.headers.get('set-cookie'),/HttpOnly/);
  const excessive=JSON.stringify({password,padding:padding+'x'});
  assert.ok(excessive.length<2048);
  assert.equal(Buffer.byteLength(excessive),2049);
  assert.equal((await handler(request('login',{method:'POST',headers:{Origin:env.APP_ORIGIN,'Content-Type':'application/json'},body:excessive}))).status,413);
});

test('malformed JSON, invalid UTF-8 and failed body streams return safe login errors',async()=>{
  const handler=createHandler(env,{now:()=>now});
  const invalidUtf8=Uint8Array.from([...new TextEncoder().encode('{"password":"'),255,...new TextEncoder().encode('"}')]);
  const failed=new ReadableStream({start(controller){controller.error(Error('private-stream-error'));}});
  for (const body of ['{','',invalidUtf8,failed]) {
    const response=await handler(request('login',{method:'POST',headers:{Origin:env.APP_ORIGIN,'Content-Type':'application/json'},body,duplex:'half'}));
    assert.equal(response.status,400);
    assert.deepEqual(await response.json(),{error:'无法读取登录请求。'});
  }
});

test('owner-selected passwords below 16 characters match exactly and rotate existing sessions',async()=>{
  const chosen='Owner!24680';
  const changed={...env,DASHBOARD_PASSWORD_SHA256:createHash('sha256').update(chosen).digest('hex')};
  const handler=createHandler(changed,{now:()=>now});
  assert.equal((await handler(login(env.APP_ORIGIN,chosen))).status,200);
  for (const [index,value] of [password,'',null,chosen+' ',chosen.toLowerCase(),'x'.repeat(257)].entries()) {
    // Distinct client keys keep this test about password matching, not throttling.
    assert.equal((await handler(...loginFrom(`198.51.100.${index}`,value))).status,401);
  }
  assert.equal(await authenticated(request('session',{headers:{Cookie:await ownerCookie()}}),changed,now),false);
});

test('repeated login failures lock that client with exponential backoff and Retry-After',async()=>{
  let time=new Date(now);
  const handler=createHandler(env,{now:()=>time});
  for (let attempt=0;attempt<5;attempt++) assert.equal((await handler(...loginFrom('203.0.113.9','wrong'))).status,401);
  const locked=await handler(...loginFrom('203.0.113.9',password));
  assert.equal(locked.status,429);assert.equal((await locked.json()).configured,undefined);
  const retryAfter=Number(locked.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter)&&retryAfter>=1&&retryAfter<=30);
  assert.equal((await handler(...loginFrom('203.0.113.8','wrong'))).status,401);
  time=new Date(now.getTime()+31000);
  assert.equal((await handler(...loginFrom('203.0.113.9',password))).status,200);
});

test('a successful login resets that client counter but not other clients',async()=>{
  const handler=createHandler(env,{now:()=>new Date(now)});
  for (let attempt=0;attempt<4;attempt++) assert.equal((await handler(...loginFrom('203.0.113.10','wrong'))).status,401);
  assert.equal((await handler(...loginFrom('203.0.113.10'))).status,200);
  for (let attempt=0;attempt<4;attempt++) assert.equal((await handler(...loginFrom('203.0.113.10','wrong'))).status,401);
  assert.equal((await handler(...loginFrom('203.0.113.10','wrong'))).status,401);
  assert.equal((await handler(...loginFrom('203.0.113.10','wrong'))).status,429);
});

test('rotating client keys cannot outpace the global failure cap',async()=>{
  let time=new Date(now);
  const handler=createHandler(env,{now:()=>time});
  for (let attempt=0;attempt<20;attempt++) assert.equal((await handler(...loginFrom(`198.51.100.${attempt}`,'wrong'))).status,401);
  const locked=await handler(...loginFrom('198.51.100.77',password));
  assert.equal(locked.status,429);assert.ok(Number(locked.headers.get('retry-after'))>=1);
  time=new Date(now.getTime()+31000);
  assert.equal((await handler(...loginFrom('198.51.100.77',password))).status,200);
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

function partialCache(error,status='ok') {
  let time=new Date(now),calls=0,failure=error;
  const off=id=>({id,status:'unconfigured'});
  const providers={
    readGoogle:async()=>{
      calls++;
      return {ga4:{id:'ga4',status,fetchedAt:time.toISOString(),metrics:{pageViews:status==='empty'?null:4},metadata:{optionalErrors:failure?{realtime:failure}:{}}},'search-console':off('search-console')};
    },
    readCloudflare:async()=>off('cloudflare'),readVercel:async()=>off('vercel'),readBing:async()=>off('bing'),
  };
  return {dashboard:createDashboard(env,{providers,now:()=>time}),advance:ms=>{time=new Date(time.getTime()+ms);},recover:()=>{failure=null;},calls:()=>calls};
}

test('transient optional report failures use a short cache and recover without discarding core data',async()=>{
  const failures=[{code:'network',status:null},{code:'timeout',status:null},{code:'quota',status:429},{code:'upstream',status:408},{code:'upstream',status:429},{code:'upstream',status:503}];
  for (const failure of failures) {
    const fixture=partialCache(failure);
    const initial=await fixture.dashboard.read(7);
    assert.equal(Date.parse(initial.cache.expiresAt)-now.getTime(),30000);
    assert.equal(initial.sources.ga4.metrics.pageViews,4);
    assert.deepEqual(initial.sources.ga4.metadata.optionalErrors.realtime,failure);
    fixture.advance(29999);
    assert.equal((await fixture.dashboard.read(7)).cache.hit,true);
    assert.equal(fixture.calls(),1);
    fixture.recover();fixture.advance(1);
    const recovered=await fixture.dashboard.read(7);
    assert.equal(recovered.cache.hit,false);
    assert.equal(fixture.calls(),2);
    assert.equal(recovered.sources.ga4.metrics.pageViews,4);
    assert.deepEqual(recovered.sources.ga4.metadata.optionalErrors,{});
    assert.equal(Date.parse(recovered.cache.expiresAt)-(now.getTime()+30000),300000);
  }
});

test('empty core reports with a transient optional error can retry without becoming fabricated zeros',async()=>{
  const fixture=partialCache({code:'network',status:null},'empty');
  const initial=await fixture.dashboard.read(7);
  assert.equal(initial.sources.ga4.status,'empty');
  assert.equal(initial.sources.ga4.metrics.pageViews,null);
  assert.equal(Date.parse(initial.cache.expiresAt)-now.getTime(),30000);
  fixture.advance(31000);
  assert.equal((await fixture.dashboard.read(7)).cache.hit,false);
  assert.equal(fixture.calls(),2);
});

test('stable optional capability, configuration and client errors retain the normal cache duration',async()=>{
  const failures=[{code:'coverage',status:null},{code:'unsupported',status:null},{code:'configuration',status:400},{code:'authorization',status:403},{code:'range',status:null},{code:'upstream',status:400},{code:'upstream',status:404},{code:'response',status:200},{code:'upstream',status:null}];
  for (const failure of failures) {
    const fixture=partialCache(failure);
    const initial=await fixture.dashboard.read(7);
    assert.equal(Date.parse(initial.cache.expiresAt)-now.getTime(),300000);
    fixture.advance(31000);
    const cached=await fixture.dashboard.read(7);
    assert.equal(cached.cache.hit,true);
    assert.deepEqual(cached.sources.ga4.metadata.optionalErrors.realtime,failure);
    assert.equal(fixture.calls(),1);
    fixture.advance(269000);
    assert.equal((await fixture.dashboard.read(7)).cache.hit,false);
    assert.equal(fixture.calls(),2);
  }
});

test('upstream credentials and URLs stay out of safe failures while incident cause remains inspectable',async()=>{
  const cause=Error('https://private.example/?apikey=secret');let error;
  try{await requestJSON('https://private.example/?apikey=secret',{fetchImpl:async()=>{throw cause;}});}catch(e){error=e;}
  assert.equal(error.cause,cause);assert.equal(error.code,'network');
  assert.doesNotMatch(JSON.stringify({code:error.code,message:error.message}),/private|apikey|secret/);
});

test('concurrent logins reserve per-client and global budgets before reading bodies',async()=>{
  for (const rotating of [false,true]) {
    const handler=createHandler(env,{now:()=>now});
    const responses=await Promise.all(Array.from({length:25},(_,index)=>handler(...loginFrom(rotating?`198.51.100.${index}`:'198.51.100.1','wrong'))));
    assert.equal(responses.filter(response=>response.status===401).length,rotating?20:5);
    assert.equal(responses.filter(response=>response.status===429).length,rotating?5:20);
    for (const response of responses.filter(response=>response.status===429)) assert.ok(Number(response.headers.get('retry-after'))>=1);
  }
});

test('completed successful and unreadable login attempts release their reservations',async()=>{
  const handler=createHandler(env,{now:()=>now});
  for (let index=0;index<25;index++) {
    assert.equal((await handler(...loginFrom('198.51.100.1'))).status,200);
    assert.equal((await handler(request('login',{method:'POST',headers:{Origin:env.APP_ORIGIN,'Content-Type':'application/json'},body:'{'}),'198.51.100.1')).status,400);
  }
  for (let index=0;index<5;index++) assert.equal((await handler(...loginFrom('198.51.100.1','wrong'))).status,401);
  assert.equal((await handler(...loginFrom('198.51.100.1'))).status,429);
});

test('generic handler ignores forged client-IP headers without an adapter-supplied key',async()=>{
  const handler=createHandler(env,{now:()=>now});
  for (let index=0;index<6;index++) {
    const response=await handler(request('login',{method:'POST',headers:{Origin:env.APP_ORIGIN,'Content-Type':'application/json','cf-connecting-ip':`198.51.100.${index}`,'x-forwarded-for':`198.51.100.${index}`,'x-vercel-forwarded-for':`198.51.100.${index}`},body:JSON.stringify({password:'wrong'})}));
    assert.equal(response.status,index<5?401:429);
  }
});
