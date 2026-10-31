import {configFrom} from './config.js';
import {providerFailure} from './common.js';
import {readGoogle} from './providers/google.js';
import {readCloudflare} from './providers/cloudflare.js';
import {readVercel} from './providers/vercel.js';
import {readBing} from './providers/bing.js';

function transientOptionalError(error) {
  if (!error || ['coverage','unsupported','configuration','authorization','range'].includes(error.code)) return false;
  return ['network','timeout','quota'].includes(error.code) || error.status === 408 || error.status === 429 || (error.status >= 500 && error.status < 600);
}

// Best-effort warm-instance cache only. It is not a session store or durable database.
export function createDashboard(env, {fetchImpl = globalThis.fetch, now = () => new Date(), providers = {readGoogle,readCloudflare,readVercel,readBing}} = {}) {
  const config = configFrom(env), cached = new Map(), running = new Map();
  async function read(days) {
    const time=now(), previous=cached.get(days);
    if (previous && previous.expires > time.getTime()) return {...previous.value,cache:{hit:true,expiresAt:new Date(previous.expires).toISOString(),scope:'warm-instance'}};
    if (running.has(days)) return running.get(days);
    const operation=(async()=>{
      const budget=AbortSignal.timeout(30000);
      const boundedFetch=(url,options={})=>fetchImpl(url,{...options,signal:options.signal ? AbortSignal.any([budget,options.signal]) : budget});
      const options={days,now:time,fetchImpl:boundedFetch};
      const jobs=[
        ['google','Google',()=>providers.readGoogle(config,options)],
        ['cloudflare','Cloudflare',()=>providers.readCloudflare(config,options)],
        ['vercel','Vercel',()=>providers.readVercel(config,options)],
        ['bing','Bing Webmaster',()=>providers.readBing(config,options)],
      ];
      const results=await Promise.allSettled(jobs.map(([, ,call])=>call()));
      const sources={};
      results.forEach((result,index)=>{
        const [id,name]=jobs[index];
        if (result.status==='fulfilled') {
          if(id==='google') Object.assign(sources,result.value); else sources[id]=result.value;
        } else if(id==='google') {
          sources.ga4=providerFailure('ga4','Google Analytics',result.reason,time);
          sources['search-console']=providerFailure('search-console','Google Search Console',result.reason,time);
        } else sources[id]=providerFailure(id,name,result.reason,time);
      });
      for (const [id,source] of Object.entries(sources)) {
        const old=previous?.value.sources[id];
        if (source.status==='error' && old && ['ok','empty','stale'].includes(old.status) && time.getTime()-Date.parse(old.fetchedAt)<3600000) {
          sources[id]={...old,status:'stale',error:source.error,lastAttemptAt:time.toISOString(),note:'本次读取失败，暂时保留上次数据。请留意更新时间。'};
        }
      }
      const hasErrors=Object.values(sources).some(s=>['error','stale'].includes(s.status) || Object.values(s.metadata?.optionalErrors || {}).some(transientOptionalError));
      const expires=time.getTime()+(hasErrors?30000:300000);
      const value={site:config.site,generatedAt:time.toISOString(),days,sources,presentation:{primarySource:config.primarySource,events:config.eventConfig,warnings:config.presentationWarnings}};
      cached.set(days,{value,expires});
      return {...value,cache:{hit:false,expiresAt:new Date(expires).toISOString(),scope:'warm-instance'}};
    })();
    running.set(days,operation);
    try { return await operation; } finally { running.delete(days); }
  }
  return {read};
}
