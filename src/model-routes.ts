// 面板模型目录、模型发现、连接测试和设置接口。
// Keys are accepted on input only; responses and logs carry at most a 4-char hint.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Store } from './store.js';
import { loadConfig, redact } from './config.js';
import { checkBaseUrl, keyHints, keySlot, readModelKey, readPanelSettings, toConfigModel, type PanelModel, type ReasoningLevel } from './settings.js';
import { discoverModels, findCatalogModel, isCustom, listModels, listProviders, type ModelInfo } from './model-catalog.js';
import { ModelService,runCompletion,connectionCheck } from './model.js';
import { ModelLibraryError,ModelLibraryService } from './model-library.js';
import { registerModelLibraryRoutes } from './model-library-routes.js';

export type LastTest = { ok:boolean; at:number; latencyMs:number; provider:string; id:string; input?:number; output?:number; error?:string; callId?:string; usage?:unknown; cost?:unknown; pricingStatus?:string };
type Deps = { store:Store; run?:typeof runCompletion; discover?:typeof discoverModels };

class HttpError extends Error { constructor(message:string, public code = 400) { super(message); } }
const CUSTOM_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const CUSTOM_REASONING_LEVELS = ['off', 'low', 'medium', 'high'];

function int(v:unknown, min:number, max:number, label:string):number {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new HttpError(label + '超出范围');
  return v as number;
}

function scrub(text:string, key?:string):string {
  const out = redact(text);
  return key && key.length >= 4 ? out.split(key).join('[已隐藏]') : out;
}

async function infoFor(provider:string, id:string, isCustomModel:boolean):Promise<ModelInfo|undefined> {
  if (isCustomModel) {const info=await findCatalogModel(id);return info?{...info,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},costKnown:false}:undefined;}
  return (await listModels(provider)).find(m => m.id === id);
}

function levelsFor(info:ModelInfo|undefined, provider:string, custom?:{reasoning:boolean}):string[] {
  if (info) return info.levels;
  return provider === 'custom' && custom?.reasoning ? CUSTOM_REASONING_LEVELS : ['off'];
}

async function validateModel(raw:any):Promise<{settings:PanelModel; info?:ModelInfo}> {
  if (!raw || typeof raw !== 'object') throw new HttpError('模型设置无效');
  const provider = String(raw.provider ?? '');
  try { checkBaseUrl(raw.baseUrl); } catch (e:any) { throw new HttpError(e.message); }
  const id = String(raw.id ?? '').trim();
  if (!id || id.length > 200) throw new HttpError('请选择或填写模型');
  const settings:PanelModel = { provider, baseUrl: String(raw.baseUrl).trim(), id, reasoningLevel: String(raw.reasoningLevel ?? 'off') as ReasoningLevel };
  if (provider === 'custom') {
    if (!CUSTOM_APIS.includes(raw.api)) throw new HttpError('请选择接口协议');
    settings.api = raw.api;
  } else if (!(await listProviders()).some(p => p.id === provider && p.available)) throw new HttpError('服务商尚未接入或不存在');
  const info = await infoFor(provider, id, provider === 'custom');
  if (provider === 'custom' && !info) {
    settings.custom = { contextWindow: raw.custom?.contextWindow === undefined ? 128000 : int(raw.custom.contextWindow, 1000, 10000000, '上下文长度'), reasoning: raw.custom?.reasoning === true };
  }
  if (!levelsFor(info, provider, settings.custom).includes(settings.reasoningLevel)) throw new HttpError('该模型不支持这个推理档位');
  return { settings, info };
}

function keyFor(provider:string, baseUrl:string, typed:unknown):string {
  const key = typeof typed === 'string' ? typed.trim() : '';
  if (key) { if (key.length > 1000 || /\s/.test(key)) throw new HttpError('API Key 格式无效'); return key; }
  const saved = readModelKey(keySlot(provider, baseUrl));
  if (!saved) throw new HttpError('请先填写 API Key');
  return saved;
}

export function registerModelRoutes(app:FastifyInstance, deps:Deps):void {
  const service=new ModelService(deps.store,deps.run??runCompletion);
  const library=new ModelLibraryService(deps);
  registerModelLibraryRoutes(app,library);
  const discover = deps.discover ?? discoverModels;
  let busy = false;

  const handle = (fn:(req:any, reply:FastifyReply) => Promise<unknown>) => async (req:any, reply:FastifyReply) => {
    try { return await fn(req, reply); }
    catch (e) { if (e instanceof HttpError) return reply.code(e.code).send({ error: e.message }); if(e instanceof ModelLibraryError)return reply.code(e.statusCode).send({error:e.message,...e.extra});throw e; }
  };
  const exclusive = (fn:(req:any, reply:FastifyReply) => Promise<unknown>) => handle(async (req, reply) => {
    if (busy) throw new HttpError('已有请求进行中', 409);
    busy = true;
    try { return await fn(req, reply); } finally { busy = false; }
  });

  app.get('/api/model', handle(async () => {
    const settings = readPanelSettings({ tolerant: true }).model ?? null;
    let effective:{provider:string; id:string; api:string; baseUrl:string}|null = null;
    let source:'panel'|'config' = settings ? 'panel' : 'config';
    let info:ModelInfo|null = null;
    let configError = '';
    try {
      const m = loadConfig().model;
      source = m.source === 'panel' ? 'panel' : 'config';
      effective = { provider: m.provider, id: m.id, api: m.api, baseUrl: m.baseUrl };
      if (m.id) info = (await infoFor(m.provider, m.id, isCustom(m)).catch(() => undefined)) ?? null;
    } catch (e) { configError = redact(e instanceof Error ? e.message : e); }
    let lastTest:LastTest|null = null;
    try { lastTest = JSON.parse(deps.store.get('model:lastTest', 'null')); } catch {}
    let modelLibrary:Awaited<ReturnType<ModelLibraryService['view']>>|null=null;
    try{modelLibrary=await library.view();}catch(error){configError=configError||scrub(error instanceof Error?error.message:String(error));}
    return { source, settings, revision:readPanelSettings({tolerant:true}).revisions?.model??0,effective, info, keys: keyHints(), lastTest, configError,library:modelLibrary };
  }));

  app.get('/api/model/providers', handle(async () => listProviders()));

  app.get('/api/model/providers/:id/models', handle(async (req) => {
    try { return await listModels(String(req.params.id)); } catch { throw new HttpError('未知服务商', 404); }
  }));

  app.post('/api/model/discover', exclusive(async (req) => {
    const b = req.body ?? {};
    const provider = String(b.provider ?? '');
    try { checkBaseUrl(b.baseUrl); } catch (e:any) { throw new HttpError(e.message); }
    if (provider === 'custom' ? (b.api !== undefined && b.api !== '' && !CUSTOM_APIS.includes(b.api)) : !(await listProviders()).some(p => p.id === provider && p.available)) throw new HttpError(provider === 'custom' ? '请选择接口协议' : '服务商尚未接入或不存在');
    const apiKey = keyFor(provider, String(b.baseUrl), b.apiKey);
    try {
      const r = await discover({ provider, baseUrl: String(b.baseUrl).trim(), api: provider === 'custom' && b.api ? b.api : undefined, apiKey });
      deps.store.log('model-discover', provider + ' 拉取到 ' + r.total + ' 个模型');
      return r;
    } catch (e:any) {
      const error = scrub(e?.message ?? String(e), apiKey);
      deps.store.log('model-discover', provider + ' 拉取失败：' + error, 'warn');
      throw new HttpError(error, 502);
    }
  }));

  app.post('/api/model/test', exclusive(async (req) => {
    const b = req.body ?? {};
    const { settings, info } = await validateModel(b.settings);
    const apiKey = keyFor(settings.provider, settings.baseUrl, b.apiKey);
    const levels = levelsFor(info, settings.provider, settings.custom);
    const level = levels.includes('off') ? 'off' : levels[0];
    const started = Date.now();
    let result:LastTest;
    try {
      const r = await connectionCheck(service,toConfigModel(settings),apiKey,level,{purpose:'model-test',source:'panel'});
      const ok = r.ok;
      result = { ok, at: Date.now(), latencyMs: r.latencyMs, provider: settings.provider, id: settings.id, input: r.input, output: r.output,callId:r.callId,usage:r.usage,cost:r.cost,pricingStatus:r.pricingStatus,...(ok ? {} : { error: scrub(r.errorMessage || '模型返回 ' + r.stopReason, apiKey) }) };
    } catch (e:any) {
      result = { ok: false, at: Date.now(), latencyMs: Date.now() - started, provider: settings.provider, id: settings.id,callId:e?.callId,error: scrub(e?.message ?? String(e), apiKey) };
    }
    deps.store.set('model:lastTest', JSON.stringify(result));
    deps.store.log('model-test', settings.provider + '/' + settings.id + (result.ok ? ' 通过 ' : ' 失败 ') + result.latencyMs + 'ms' + (result.error ? '：' + result.error : ''), result.ok ? 'info' : 'warn');
    return result;
  }));

  app.put('/api/model', handle(async (req) => {
    const b = req.body ?? {};
    const { settings } = await validateModel(b.settings);
    const typed = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
    const key = keyFor(settings.provider, settings.baseUrl, typed);
    let revision:number;
    try{const saved=library.saveLegacy(settings,b.revision,key,!!typed);revision=saved.settings.revisions?.model??0;}catch(e:any){if(e?.code==='REVISION_CONFLICT'||e?.statusCode===409)throw new HttpError('模型设置已被修改，请重新读取后保存',409);throw e;}
    deps.store.log('model-save', '模型已保存：' + settings.provider + '/' + settings.id + '，下一轮处理生效');
    return { ok: true, settings,revision,keys: keyHints() };
  }));

}
