// Pure helpers for the model page: formatting, key slots, reasoning levels, form <-> settings.

export const API_LABEL = {
  'openai-completions': 'OpenAI Chat', 'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic',
  'google-generative-ai': 'Google', 'mistral-conversations': 'Mistral',
};
export const CUSTOM_APIS = [
  { value: 'openai-completions', title: 'OpenAI Chat', hint: '多数中转站、国产模型' },
  { value: 'openai-responses', title: 'OpenAI Responses', hint: 'OpenAI 新接口' },
  { value: 'anthropic-messages', title: 'Anthropic', hint: 'Claude 及兼容接口' },
];
export const LEVEL_LABEL = { off: '关' };
const CUSTOM_REASONING_LEVELS = ['off', 'low', 'medium', 'high'];

export function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n >= 1e6 ? Number((n / 1e6).toFixed(2)) + 'M' : Math.round(n / 1000) + 'K';
}

export function fmtPrice(cost) {
  if (!cost || (!cost.input && !cost.output)) return '—';
  return '$' + cost.input + ' / $' + cost.output;
}

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

// Must match the backend keySlot(): `${provider}@${hostname}`.
export function slotOf(provider, baseUrl) {
  const host = hostOf(baseUrl);
  return provider && host ? provider + '@' + host : '';
}

export function levelsOf(info, provider, custom) {
  if (info) return info.levels?.length ? info.levels : ['off'];
  return provider === 'custom' && custom?.reasoning ? CUSTOM_REASONING_LEVELS : ['off'];
}

export function defaultLevel(levels) {
  return levels.includes('off') ? 'off' : levels[0];
}

export function emptyForm() {
  return { provider: '', baseUrl: '', api: 'openai-completions', id: '', reasoningLevel: 'off', maxTokens: 1024, timeoutSec: 60, custom: { contextWindow: 128000, reasoning: false } };
}

export function formFrom(settings) {
  const f = emptyForm();
  if (!settings) return f;
  return {
    ...f,
    provider: settings.provider, baseUrl: settings.baseUrl, api: settings.api || f.api, id: settings.id,
    reasoningLevel: settings.reasoningLevel || 'off', maxTokens: settings.maxTokens, timeoutSec: Math.round(settings.timeoutMs / 1000),
    custom: settings.custom ? { ...settings.custom } : f.custom,
  };
}

// `known` = the model is recognised (catalog info exists); unknown custom models carry their own params.
export function settingsFrom(form, known) {
  const s = {
    provider: form.provider, baseUrl: form.baseUrl.trim(), id: form.id.trim(), reasoningLevel: form.reasoningLevel,
    maxTokens: Number(form.maxTokens), timeoutMs: Math.round(Number(form.timeoutSec) * 1000),
  };
  if (form.provider === 'custom') {
    s.api = form.api;
    if (!known) s.custom = { contextWindow: Number(form.custom.contextWindow), reasoning: !!form.custom.reasoning };
  }
  return s;
}
