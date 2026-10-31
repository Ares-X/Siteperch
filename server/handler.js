import {authenticated,authConfigured,passwordMatches,sessionCookie,clearSession,sameOrigin} from './auth.js';
import {createDashboard} from './dashboard.js';
import {createLoginThrottle} from './throttle.js';
const SECURITY_HEADERS={
  'Cache-Control':'private, no-store', 'Content-Type':'application/json; charset=utf-8',
  'X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow, noarchive',
  'Referrer-Policy':'no-referrer','Vary':'Cookie',
};
function json(value,status=200,headers={}) { return new Response(JSON.stringify(value),{status,headers:{...SECURITY_HEADERS,...headers}}); }
class LoginBodyTooLarge extends Error {}
async function readLoginBody(request) {
  const limit=2048, reader=request.body?.getReader();
  if (!reader) throw new SyntaxError('Missing JSON body');
  const rejectLargeBody=()=>{
    // Cancellation can be asynchronous; the response must not wait for the sender.
    void reader.cancel().catch(()=>{});
    throw new LoginBodyTooLarge();
  };
  try {
    const declared=request.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared)>limit) rejectLargeBody();
    const bytes=new Uint8Array(limit);
    let length=0;
    while (true) {
      const {done,value}=await reader.read();
      if (done) break;
      if (length+value.byteLength>limit) rejectLargeBody();
      bytes.set(value,length);
      length+=value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));
  } finally { reader.releaseLock(); }
}
export function createHandler(env, {now=()=>new Date(),dashboard,fetchImpl} = {}) {
  const reports=dashboard || createDashboard(env,{now,fetchImpl});
  const loginThrottle=createLoginThrottle({now});
  return async function handle(request, clientKey = 'unknown') {
    const url=new URL(request.url), path=url.pathname.replace(/\/$/,'');
    if (!['/api/session','/api/login','/api/logout','/api/summary'].includes(path)) return json({error:'找不到此接口。'},404);
    const method=path==='/api/login'||path==='/api/logout'?'POST':'GET';
    if (request.method!==method) return json({error:'不支持此请求方式。'},405,{Allow:method});
    const configured=authConfigured(env);
    if (path==='/api/session') return json({authenticated:await authenticated(request,env,now()),configured});
    if (!configured) return json({error:'看板访问口令尚未在托管后端配置。',configured:false},503);
    if (request.method==='POST' && !sameOrigin(request,env)) return json({error:'请求来源不匹配。'},403);
    if (path==='/api/login') {
      if (!request.headers.get('content-type')?.startsWith('application/json')) return json({error:'请使用 JSON 提交口令。'},415);
      // Adapters supply a platform-authenticated key; request headers are not
      // trusted here. Reserve synchronously before any body or crypto awaits.
      const attempt=loginThrottle.reserve(clientKey);
      if (!attempt.allowed) return json({error:'尝试过于频繁，请稍后再试。'},429,{'Retry-After':String(attempt.retryAfterSeconds)});
      let outcome;
      try {
        let body;
        try { body=await readLoginBody(request); }
        catch (error) { return error instanceof LoginBodyTooLarge ? json({error:'请求过大。'},413) : json({error:'无法读取登录请求。'},400); }
        if(!await passwordMatches(body?.password,env)) { outcome='failure'; return json({error:'访问口令不正确。'},401); }
        outcome='success';
        return json({authenticated:true},200,{'Set-Cookie':await sessionCookie(request,env,now())});
      } finally { attempt.finish(outcome); }
    }
    if (!await authenticated(request,env,now())) return json({error:'请先登录。'},401);
    if (path==='/api/logout') return json({authenticated:false},200,{'Set-Cookie':clearSession(request)});
    const days=Number(url.searchParams.get('days')||7);
    if(![7,28].includes(days))return json({error:'请选择近 7 天或近 28 天。'},400);
    try { return json(await reports.read(days)); }
    catch (error) {
      // Preserve incident cause in runtime logs without credentials, upstream URLs or response bodies.
      console.error('observatory.summary_failed',{type:error?.name||'Error'});
      return json({error:'暂时无法读取看板，请稍后再试。'},502);
    }
  };
}
const handlers=new WeakMap();
export function handleRequest(request,env,clientKey) {
  if(!handlers.has(env))handlers.set(env,createHandler(env));
  return handlers.get(env)(request,clientKey);
}
