import {handleRequest} from '../server/handler.js';
export default {fetch: request => handleRequest(request,process.env)};
