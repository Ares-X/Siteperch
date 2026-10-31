import {handleRequest} from './handler.js';
export default {fetch(request,env) {
  if(new URL(request.url).pathname.startsWith('/api/'))return handleRequest(request,env,request.headers.get('cf-connecting-ip')?.trim() || 'unknown');
  return env.ASSETS.fetch(request);
}};
