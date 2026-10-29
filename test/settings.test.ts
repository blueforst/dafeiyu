import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { panelDir, readPanelSettings, writePanelSettings, keySlot, readModelKey, writeModelKey, keyHint, checkBaseUrl } from '../src/settings.js';
import { loadConfig, redact } from '../src/config.js';
import { writeExampleConfig } from './config-fixture.js';

function sandbox() {
  const root = mkdtempSync(tmpdir() + '/role-settings-');
  mkdirSync(root + '/data'); mkdirSync(root + '/secrets');
  const prev = { data: process.env.DATA_DIR, secrets: process.env.SECRETS_DIR };
  process.env.DATA_DIR = root + '/data'; process.env.SECRETS_DIR = root + '/secrets';
  const configPath = root + '/config.json';
  writeExampleConfig(configPath);
  return {
    configPath,
    close() {
      if (prev.data === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev.data;
      if (prev.secrets === undefined) delete process.env.SECRETS_DIR; else process.env.SECRETS_DIR = prev.secrets;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('Key 槽位只按服务商和 hostname 计算', () => {
  assert.equal(keySlot('custom', 'https://Relay.Example.com:8443/v1/'), 'custom@relay.example.com');
  assert.equal(keySlot('deepseek', 'https://api.deepseek.com'), 'deepseek@api.deepseek.com');
});

test('Key 按槽位保存，文件权限 0600，只提示末四位', () => {
  const s = sandbox();
  try {
    writeModelKey('custom@a.example', 'sk-abcdef123456');
    assert.equal(readModelKey('custom@a.example'), 'sk-abcdef123456');
    assert.equal(readModelKey('custom@b.example'), '');
    assert.equal(statSync(panelDir() + '/model-keys.json').mode & 0o777, 0o600);
    assert.equal(keyHint('sk-abcdef123456'), '••••3456');
    assert.equal(keyHint(''), '');
  } finally { s.close(); }
});

test('Base URL 拒绝本机、元数据地址、内部服务和带凭据的地址', () => {
  for (const bad of ['http://localhost:1', 'http://127.0.0.2/v1', 'http://169.254.169.254', 'http://browser:3001', 'http://app:8080', 'http://u:p@x.example', 'ftp://x.example']) {
    assert.throws(() => checkBaseUrl(bad), /模型地址无效/, bad);
  }
  assert.equal(checkBaseUrl('http://mock-model:8080/v1').hostname, 'mock-model');
  assert.equal(checkBaseUrl('http://192.168.1.10:11434/v1').port, '11434');
});

test('面板设置覆盖 config.json 的模型，内置服务商不受三种协议限制', () => {
  const s = sandbox();
  try {
    writePanelSettings({ model: { provider: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', id: 'x', reasoningLevel: 'high' } });
    const c = loadConfig(s.configPath);
    assert.equal(c.model.source, 'panel');
    assert.equal(c.model.provider, 'google');
    assert.equal(c.model.reasoning, true);
    assert.equal(c.persona.length > 0, true);
  } finally { s.close(); }
});

test('没有面板设置时沿用 config.json，并标记来源', () => {
  const s = sandbox();
  try {
    const c = loadConfig(s.configPath);
    assert.equal(c.model.source, 'config');
    assert.equal(c.model.api, 'openai-completions');
  } finally { s.close(); }
});

test('面板设置文件损坏：严格读取报错，宽松读取返回空', () => {
  const s = sandbox();
  try {
    mkdirSync(panelDir(), { recursive: true });
    writeFileSync(panelDir() + '/settings.json', '{"model":');
    assert.throws(() => loadConfig(s.configPath), /面板设置文件损坏/);
    assert.deepEqual(readPanelSettings({ tolerant: true }), {});
  } finally { s.close(); }
});

test('redact 会隐藏面板保存的 Key', () => {
  const s = sandbox();
  try {
    writeModelKey('custom@a.example', 'abcd1234efgh5678');
    assert.ok(!redact('boom abcd1234efgh5678').includes('abcd1234efgh5678'));
  } finally { s.close(); }
});
