import type { Api, Model } from '@earendil-works/pi-ai';
import { createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import snapshot from './commandcode-catalog.json' with { type: 'json' };

export const COMMANDCODE_BASE = 'https://api.commandcode.ai/provider/v1';

export function commandCodeApi(id:string):string {
  const endpoints = snapshot.models.find(m => m.id === id)?.supported_endpoints;
  if (endpoints?.includes('/messages') || (!endpoints && id.startsWith('claude-'))) return 'anthropic-messages';
  return endpoints?.includes('/chat/completions') !== false ? 'openai-completions' : 'openai-responses';
}

export function commandCodeProvider(known:readonly Model<Api>[]) {
  const models:Model<Api>[] = snapshot.models.map(entry => {
    const native = known.find(m => m.id === entry.id);
    const api = commandCodeApi(entry.id);
    return {
      id: entry.id, name: entry.name, provider: 'commandcode', api,
      baseUrl: api === 'anthropic-messages' ? COMMANDCODE_BASE.slice(0, -3) : COMMANDCODE_BASE,
      contextWindow: entry.context_length, maxTokens: native?.maxTokens ?? Math.min(8192, entry.context_length),
      reasoning: native?.reasoning ?? false, thinkingLevelMap: native?.thinkingLevelMap,
      input: native?.input ?? ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false },
    } as Model<Api>;
  });
  return createProvider({
    id: 'commandcode', name: 'Command Code', baseUrl: COMMANDCODE_BASE, models,
    auth: { apiKey: { name: 'Command Code API Key', resolve: async () => ({ auth: {} }) } },
    api: { 'openai-completions': openAICompletionsApi(), 'openai-responses': openAIResponsesApi(), 'anthropic-messages': anthropicMessagesApi() },
  });
}
