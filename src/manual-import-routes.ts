import type {FastifyInstance} from 'fastify';
import {ManualImportError,type ManualImportsService} from './manual-imports.js';

/** 入口鉴权和控制请求标记沿用 app 全局钩子；提交不调用浏览器、不隐式恢复工作流。 */
export function registerManualImportRoutes(app:FastifyInstance,deps:{imports:ManualImportsService;wake?:()=>void}){
 const route=(fn:(request:any)=>unknown)=>async(request:any,reply:any)=>{try{return await fn(request);}catch(error){if(error instanceof ManualImportError)return reply.code(error.statusCode).send({error:error.message});throw error;}};
 app.post('/api/messages/import',{bodyLimit:4096},route(request=>{const body=request.body;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='url'))throw new ManualImportError('补录参数无效');const result=deps.imports.submit(body.url);if(result.status==='pending')deps.wake?.();return result;}));
 app.get('/api/messages/imports',route(request=>deps.imports.list(request.query??{})));
 app.get('/api/messages/imports/:id',route(request=>({request:deps.imports.get(String(request.params.id))})));
}
