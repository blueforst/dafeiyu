import type { FastifyInstance } from 'fastify';
import {readPanelSettings,mergePanelSettings,SettingsConflictError} from './settings.js';
import {healthSettings} from './unattended-health.js';
import type { RuntimeHealth } from './unattended-health.js';

/** 所有接口沿用应用现有鉴权，GET 只读持久结果，不访问浏览器或模型。 */
function queryLimit(value:unknown,max:number){if(value===undefined)return 30;const limit=Number(value);if(!Number.isInteger(limit)||limit<1||limit>max)throw new Error('分页数量无效');return limit;}
export function registerHealthRoutes(app:FastifyInstance,deps:{health:RuntimeHealth;accountId:()=>string}){
 app.get('/api/health/settings',async()=>{const current=readPanelSettings();return {settings:healthSettings(current.health),revision:Number(current.revisions?.health??0)};});
 app.put('/api/health/settings',async(req,reply)=>{try{const raw=req.body as any;if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Number.isInteger(raw.revision)||raw.revision<0)return reply.code(400).send({error:'健康设置需要有效修订号'});const {revision,...patch}=raw,current=readPanelSettings(),settings=healthSettings({...current.health,...patch});const saved=mergePanelSettings('health',settings,revision);return {settings,revision:saved.revision};}catch(error){return reply.code(error instanceof SettingsConflictError?409:400).send({error:error instanceof SettingsConflictError?'健康设置已被修改，请重新读取':'健康设置无效'});}});
 app.get('/api/health',async()=>deps.health.get(deps.accountId()));
 app.get('/api/health/alerts',async(req,reply)=>{try{const q=req.query as any;return deps.health.alerts(deps.accountId(),{cursor:q.cursor,limit:queryLimit(q.limit,100)});}catch{return reply.code(400).send({error:'告警查询参数无效'});}});
 app.get('/api/health/reports',async(req,reply)=>{try{return {items:deps.health.reports(deps.accountId(),queryLimit((req.query as any).limit,30))};}catch{return reply.code(400).send({error:'日报查询参数无效'});}});
 app.get('/api/health/reports/:date',async(req,reply)=>{try{const report=deps.health.report(String((req.params as any).date),deps.accountId());return report??reply.code(404).send({error:'日报不存在'});}catch{return reply.code(400).send({error:'日报日期无效'});}});
}
