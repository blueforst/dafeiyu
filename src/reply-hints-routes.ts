import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { readPanelSettings,mergePanelSettings } from './settings.js';
import { validatePromptHints } from './reply-hints.js';

export function registerPromptHintsRoutes(app:FastifyInstance,{store}:{store:Store}):void {
 const handle=(fn:(req:any)=>unknown)=>async(req:any,reply:any)=>{
  try{return fn(req);}catch(error:any){const status=error.statusCode??500;return reply.code(status).send({error:status>=500?'动态提醒操作失败':String(error.message),...(status===409?{revision:error.revision}:{})});}
 };
 const get=()=>{const settings=readPanelSettings();return {promptHints:validatePromptHints(settings.promptHints??{}),revision:settings.revisions?.promptHints??0};};
 app.get('/api/persona/prompt-hints',handle(get));
 app.put('/api/persona/prompt-hints',handle(req=>{
  if(!Number.isInteger(req.body?.revision)||req.body.revision<0){const error:any=new Error('保存动态提醒需要当前修订号');error.statusCode=400;throw error;}
  const promptHints=validatePromptHints(req.body?.promptHints),saved=mergePanelSettings('promptHints',promptHints,req.body.revision);
  store.log('prompt-hints-save','动态提醒已保存，下一轮生效');
  return {ok:true,promptHints,revision:saved.revision};
 }));
}
