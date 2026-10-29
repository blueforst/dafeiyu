import type {FastifyInstance} from 'fastify';
import proxy from '@fastify/http-proxy';
import type {Socket} from 'node:net';

type Control={control:()=>string;controlEpoch:()=>number;onControlRevision:(listener:()=>void)=>()=>void};
/** 同步控制代次关闭下游 socket，覆盖正在鉴权、连接上游和已升级的连接。 */
export async function registerDesktopProxy(app:FastifyInstance,control:Control,upstream='http://browser:6080'){
 const sockets=new Map<Socket,number>();
 const disconnect=()=>{for(const socket of sockets.keys())socket.destroy();sockets.clear();};
 const unsubscribe=control.onControlRevision(disconnect);
 const upgrade=(request:any,socket:Socket)=>{
  if(!/^\/desktop(?:\/|\?|$)/.test(request.url??''))return;
  sockets.set(socket,control.controlEpoch());socket.once('close',()=>sockets.delete(socket));
 };
 // 代理插件也注册upgrade监听；在全部插件就绪后置前，确保鉴权前已冻结代次。
 app.addHook('onReady',async()=>{app.server.prependListener('upgrade',upgrade);});
 app.addHook('onClose',async()=>{unsubscribe();disconnect();app.server.removeListener('upgrade',upgrade);});
 await app.register(proxy,{upstream,prefix:'/desktop',rewritePrefix:'/',websocket:true,preHandler:async(req,reply)=>{
  if(control.control()!=='manual'||req.headers.upgrade?.toLowerCase()==='websocket'&&sockets.get(req.raw.socket)!==control.controlEpoch())return reply.code(423).send({error:'请先点击人工接管，再打开浏览器桌面'});
 }});
}
