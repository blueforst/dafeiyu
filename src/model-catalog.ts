// pi model catalog for the panel, and the runtime model each request uses.
import type { Api, Model } from '@earendil-works/pi-ai';
import { createModels, createProvider, getSupportedThinkingLevels, type Models } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import type { Config } from './types.js';
import { commandCodeProvider, commandCodeApi, COMMANDCODE_BASE } from './commandcode.js';

export type ProviderInfo = { id:string; name:string; group:'cn'|'intl'; baseUrl:string; apis:string[]; modelCount:number; available:boolean; reason:string; source:'pi'|'preset' };
export type ModelInfo = { id:string; name:string; api:string; baseUrl:string; contextWindow:number; maxTokens:number; reasoning:boolean; levels:string[]; vision:boolean; cost:{input:number;output:number;cacheRead:number;cacheWrite:number}; costKnown:boolean };

const CN = new Set(['deepseek', 'moonshotai-cn', 'zai-coding-cn', 'qwen-token-plan-cn', 'minimax-cn', 'xiaomi', 'xiaomi-token-plan-cn', 'ant-ling']);
const UNKNOWN_DEFAULTS = { contextWindow: 128000, maxTokens: 8192 };

let catalogPromise:Promise<Models>|undefined;
function catalog():Promise<Models> {
  return catalogPromise ??= import('@earendil-works/pi-ai/providers/all').then(m => {
    const models = m.builtinModels();
    models.setProvider(commandCodeProvider(models.getModels()));
    return models;
  });
}

function toInfo(m:Model<Api>):ModelInfo {
  return {
    id: m.id, name: m.name, api: m.api, baseUrl: m.baseUrl,
    contextWindow: m.contextWindow, maxTokens: m.maxTokens, reasoning: !!m.reasoning,
    levels: m.reasoning ? getSupportedThinkingLevels(m) : ['off'],
    vision: m.input.includes('image'),
    cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, cacheRead: m.cost?.cacheRead ?? 0, cacheWrite: m.cost?.cacheWrite ?? 0 },
    costKnown: m.provider !== 'commandcode',
  };
}

export async function listProviders():Promise<ProviderInfo[]> {
  const models = await catalog();
  const out:ProviderInfo[] = [];
  for (const p of models.getProviders()) {
    const list = models.getModels(p.id);
    const baseUrl = p.baseUrl || list.find(m => m.baseUrl && !m.baseUrl.includes('{'))?.baseUrl || '';
    const reason = !list.length ? '没有可用于回复的聊天模型' : !p.auth?.apiKey ? '需要订阅账号登录，尚未接入' : p.id === 'amazon-bedrock' ? '需要 AWS 认证及区域，尚未接入' : !baseUrl || baseUrl.includes('{') ? '需要云服务专用参数，尚未接入' : '';
    out.push({ id: p.id, name: p.name ?? p.id, group: CN.has(p.id) ? 'cn' : 'intl', baseUrl, apis: [...new Set(list.map(m => m.api))], modelCount: list.length, available: !reason, reason, source: p.id === 'commandcode' ? 'preset' : 'pi' });
  }
  return out;
}

async function allowed(providerId:string):Promise<Models> {
  const models = await catalog();
  const provider = (await listProviders()).find(p => p.id === providerId);
  if (!provider) throw new Error('未知服务商');
  if (!provider.available) throw new Error(provider.reason);
  return models;
}

export async function listModels(providerId:string):Promise<ModelInfo[]> {
  return (await allowed(providerId)).getModels(providerId).map(toInfo);
}

export async function findCatalogModel(id:string):Promise<ModelInfo|undefined> {
  const m = (await catalog()).getModels().find(x => x.id === id);
  return m ? toInfo(m) : undefined;
}

/** 模型库批量联查，避免对列表中的每一行重复构造整个目录。 */
export async function listCatalogModels():Promise<ModelInfo[]> {
  return (await catalog()).getModels().map(toInfo);
}

export async function primaryApi(providerId:string):Promise<string> {
  const counts = new Map<string, number>();
  for (const m of (await allowed(providerId)).getModels(providerId)) counts.set(m.api, (counts.get(m.api) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

const CUSTOM_APIS:Record<string, () => any> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
};

// Legacy config.json models keep their old meaning: provider is only a label, api comes from config.
export function isCustom(m:Config['model']):boolean { return m.provider === 'custom' || m.source !== 'panel'; }

export async function resolveRuntimeModel(m:Config['model']):Promise<{model:Model<Api>; models:Models; pricingKnown:boolean}> {
  if (!isCustom(m)) {
    const models = await allowed(m.provider);
    let model = models.getModel(m.provider, m.id);
    let pricingKnown=!!model&&m.provider!=='commandcode';
    if (!model) {
      const api = m.provider === 'commandcode' ? commandCodeApi(m.id) : await primaryApi(m.provider);
      const template = models.getModels(m.provider).find(x => x.api === api)!;
      model = { ...template, id: m.id, name: m.id, reasoning: m.custom?.reasoning??false, thinkingLevelMap: undefined, cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, ...UNKNOWN_DEFAULTS, ...(m.custom?{contextWindow:m.custom.contextWindow}:{}) };
    }
    const defaults = new Set(models.getModels(m.provider).map(item => item.baseUrl));
    if (m.provider === 'commandcode') defaults.add(COMMANDCODE_BASE);
    if (m.baseUrl && model.baseUrl !== m.baseUrl && !defaults.has(m.baseUrl)) {model = { ...model, baseUrl: m.baseUrl, cost:{input:0,output:0,cacheRead:0,cacheWrite:0} };pricingKnown=false;}
    if (m.provider === 'commandcode') model = { ...model, baseUrl: model.api === 'anthropic-messages' ? model.baseUrl.replace(/\/v1\/?$/, '') : model.baseUrl };
    return { model, models, pricingKnown };
  }
  const impl = CUSTOM_APIS[m.api];
  if (!impl) throw new Error('模型协议无效');
  const match = m.id ? await findCatalogModel(m.id) : undefined;
  const meta = match
    ? { contextWindow: match.contextWindow, maxTokens: match.maxTokens, reasoning: match.reasoning, input: (match.vision ? ['text', 'image'] : ['text']) as ('text'|'image')[] }
    : { contextWindow: m.custom?.contextWindow ?? UNKNOWN_DEFAULTS.contextWindow, maxTokens: UNKNOWN_DEFAULTS.maxTokens, reasoning: m.custom?.reasoning ?? (m.source !== 'panel' && m.reasoning), input: ['text'] as ('text'|'image')[] };
  const providerId = m.provider || 'custom';
  const model:Model<Api> = { id: m.id, name: m.id, api: m.api as Api, provider: providerId, baseUrl: m.baseUrl, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false }, ...meta } as Model<Api>;
  const models = createModels();
  models.setProvider(createProvider({ id: providerId, name: providerId, models: [model], auth: { apiKey: { name: '面板 Key', resolve: async () => ({ auth: {} }) } }, api: impl() }));
  return { model, models, pricingKnown:false };
}

export type DiscoverInput = { provider:string; baseUrl:string; api?:string; apiKey:string };
export type DiscoveredModel = { id:string; known:boolean; info?:ModelInfo };
const DISCOVER_TIMEOUT_MS = 15000;
const DISCOVER_LIMIT = 1000;

function discoveryRequest(api:string, baseUrl:string, key:string):{url:string; headers:Record<string,string>} {
  const base = baseUrl.replace(/\/+$/, '');
  if (api === 'anthropic-messages') return { url: (/\/v1$/.test(base) ? base : base + '/v1') + '/models', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } };
  if (api === 'google-generative-ai') return { url: base + '/models?key=' + encodeURIComponent(key), headers: {} };
  return { url: base + '/models', headers: { authorization: 'Bearer ' + key } };
}

function isModelListBody(body:any):boolean {
  return Array.isArray(body) || Array.isArray(body?.data) || Array.isArray(body?.models);
}

function idsFrom(body:any):string[] {
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return list.map((x:any) => typeof x === 'string' ? x : String(x?.id ?? x?.name ?? '')).map((id:string) => id.replace(/^models\//, '')).filter(Boolean);
}

async function fetchDiscoveredIds(req:{url:string; headers:Record<string,string>}, fetchImpl:typeof fetch, timeoutMs:number):Promise<string[]> {
  let response:Response;
  try { response = await fetchImpl(req.url, { headers: req.headers, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e:any) { throw new Error(e?.name === 'TimeoutError' ? '拉取失败：超时' : '拉取失败：无法连接'); }
  if (!response.ok) throw new Error('拉取失败：HTTP ' + response.status);
  let body:any;
  try { body = await response.json(); } catch { throw new Error('拉取失败：返回的不是 JSON'); }
  if (!isModelListBody(body)) throw new Error('拉取失败：返回的不是模型列表');
  return [...new Set(idsFrom(body))];
}

export async function discoverModels(input:DiscoverInput, fetchImpl:typeof fetch = fetch):Promise<{models:DiscoveredModel[]; total:number; api?:'openai-completions'|'anthropic-messages'}> {
  const builtin = input.provider !== 'custom';
  let ids:string[];
  let detectedApi:'openai-completions'|'anthropic-messages'|undefined;
  if (!builtin && !input.api) {
    const started = Date.now(), budget = 25000;
    try {
      ids = await fetchDiscoveredIds(discoveryRequest('openai-completions', input.baseUrl, input.apiKey), fetchImpl, DISCOVER_TIMEOUT_MS);
      detectedApi = 'openai-completions';
    } catch (firstErr:any) {
      const remaining = budget - (Date.now() - started);
      const firstReason = String(firstErr?.message ?? firstErr).replace(/^拉取失败：/, '');
      if (remaining <= 0) throw new Error(`拉取失败：OpenAI 兼容接口（${firstReason}）；Anthropic 兼容接口（超时）`);
      try {
        ids = await fetchDiscoveredIds(discoveryRequest('anthropic-messages', input.baseUrl, input.apiKey), fetchImpl, Math.min(DISCOVER_TIMEOUT_MS, remaining));
        detectedApi = 'anthropic-messages';
      } catch (secondErr:any) {
        const secondReason = String(secondErr?.message ?? secondErr).replace(/^拉取失败：/, '');
        throw new Error(`拉取失败：OpenAI 兼容接口（${firstReason}）；Anthropic 兼容接口（${secondReason}）`);
      }
    }
  } else {
    const api = builtin ? await primaryApi(input.provider) : input.api!;
    const mixedGateway = ['opencode', 'opencode-go', 'commandcode'].includes(input.provider);
    const req = input.provider === 'radius'
      ? { url: new URL('/v1/config', input.baseUrl).href, headers: { authorization: 'Bearer ' + input.apiKey } }
      : mixedGateway
      ? { url: input.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/models', headers: { authorization: 'Bearer ' + input.apiKey } }
      : discoveryRequest(api, input.baseUrl, input.apiKey);
    ids = await fetchDiscoveredIds(req, fetchImpl, DISCOVER_TIMEOUT_MS);
    if (!builtin && (api === 'openai-completions' || api === 'anthropic-messages')) detectedApi = api;
  }
  const own = builtin ? new Map((await listModels(input.provider)).map(m => [m.id, m])) : undefined;
  const models:DiscoveredModel[] = [];
  for (const id of ids.slice(0, DISCOVER_LIMIT)) {
    const match = own ? own.get(id) : await findCatalogModel(id);
    const info = !own&&match ? {...match,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},costKnown:false}:match;
    models.push(info ? { id, known: true, info } : { id, known: false });
  }
  return { models, total: ids.length, ...(detectedApi ? { api: detectedApi } : {}) };
}
