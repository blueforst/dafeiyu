import http from 'node:http';
import { readFileSync } from 'node:fs';
const key=readFileSync('/run/staging/ingress_key','utf8').trim();
http.createServer((req,res)=>{const headers={...req.headers,'x-ingress-key':key};delete headers.origin;delete headers.authorization;const upstream=http.request({host:'app',port:8080,path:req.url,method:req.method,headers},response=>{res.writeHead(response.statusCode??502,response.headers);response.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end('{}');});req.pipe(upstream);res.on('close',()=>upstream.destroy());}).listen(8082,'0.0.0.0');
