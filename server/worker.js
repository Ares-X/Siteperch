import {handleRequest} from './handler.js';
export default {fetch(request,env) {
  if(new URL(request.url).pathname.startsWith('/api/'))return handleRequest(request,env);
  return env.ASSETS.fetch(request);
}};
