import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {Readable} from 'node:stream';
import {createHandler} from '../server/handler.js';
const root=fileURLToPath(new URL('../public/',import.meta.url));
const port=Number(process.env.OBSERVATORY_PORT||4397),origin=`http://127.0.0.1:${port}`;
const handle=createHandler({...process.env,APP_ORIGIN:origin});
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml'};
createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/')){
      const request=new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'})});
      const response=await handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    const path=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if(!path.startsWith(root.endsWith(sep)?root:root+sep)){res.writeHead(404);res.end();return;}
    const body=await readFile(path);res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':'no-store','X-Robots-Tag':'noindex'});res.end(body);
  }catch(error){res.writeHead(error.code==='ENOENT'?404:500);res.end('Unavailable');}
}).listen(port,'127.0.0.1',()=>console.log(`Observatory local: ${origin}`));
