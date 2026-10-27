// 隔离界面验收专用静态服务；业务接口由浏览器测试拦截。
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
const root=resolve(process.env.PUBLIC_DIR||'/public');
createServer(async(req,res)=>{
 try{
  const path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(path!==root&&!path.startsWith(root+sep)){res.writeHead(403);res.end();return;}
  const file=path===root?resolve(root,'index.html'):path;
  const data=await readFile(file);
  res.writeHead(200,{'content-type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream','cache-control':'no-store'});res.end(data);
 }catch{res.writeHead(404);res.end('未找到资源');}
}).listen(Number(process.env.PORT||8083),'0.0.0.0');
