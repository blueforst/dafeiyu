// 镜像测试只复制 src/ 与 test/；保留旧示例人格以覆盖升级后的默认解析，已移除废弃的 dailyState。
import { writeFileSync } from 'node:fs';
export const exampleConfig = {
  mode: 'draft', pollSeconds: 60, maxAgeHours: 6, maxPerRound: 2, publicPerHour: 10, privatePerHour: 30,
  replyHours: {enabled:false,closeDelayMinutes:30},
  persona: '你是一个明确说明自己是 AI 的友善中文角色。简洁自然地回应用户，不编造经历或承诺，不主动发帖。',
  model: { provider: 'custom', api: 'openai-completions', baseUrl: '', id: '', reasoning: false, reasoningLevel: 'low', vision: false, maxTokens: 4096, timeoutMs: 60000 },
  retentionDays: 30,
};
export function writeExampleConfig(path: string) { writeFileSync(path, JSON.stringify(exampleConfig)); }
