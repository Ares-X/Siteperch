import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import vercel from '../api/index.js';
import worker from '../server/worker.js';

const origin='https://adapter.example';
const env={APP_ORIGIN:origin,DASHBOARD_PASSWORD_SHA256:createHash('sha256').update('fixture-owner-password').digest('hex'),DASHBOARD_SESSION_SECRET:'fixture-session-secret-over-thirty-two-characters'};
const login=headers=>new Request(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify({password:'wrong'})});

for (const platform of ['Vercel','Cloudflare Worker']) test(`${platform} throttles by its trusted adapter header despite other IP headers`,async t=>{
  if (platform==='Vercel') {
    const before=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
    Object.assign(process.env,env);
    t.after(()=>{for(const [key,value] of Object.entries(before)) {if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  }
  const trusted=platform==='Vercel'?'x-vercel-forwarded-for':'cf-connecting-ip';
  const fetch=request=>platform==='Vercel'?vercel.fetch(request):worker.fetch(request,env);
  const responses=await Promise.all(Array.from({length:25},(_,index)=>fetch(login({
    'x-forwarded-for':`198.51.100.${index}`,
    'cf-connecting-ip':`198.51.100.${index}`,
    'x-vercel-forwarded-for':`198.51.100.${index}`,
    [trusted]:'203.0.113.1',
  }))));
  assert.equal(responses.filter(response=>response.status===401).length,5);
  assert.equal(responses.filter(response=>response.status===429).length,20);
  assert.equal((await fetch(login({[trusted]:'203.0.113.2'}))).status,401);
});
