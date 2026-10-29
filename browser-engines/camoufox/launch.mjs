import { Camoufox, getRandomPreset } from 'camoufox';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';

// 显式恢复 Mozilla 安全阻断列表；内核补丁仍由固定的配对发行版提供。
const securityPrefs={'services.settings.server':'https://firefox.settings.services.mozilla.com/v1','extensions.blocklist.enabled':true};

export async function observer(proxy, options={}) {
  mkdirSync('/tmp/role-camoufox-fontconfig', { recursive: true, mode: 0o700 });
  return Camoufox({ headless: true, os: 'linux', locale: 'en-US', exclude_addons: ['UBO'], firefox_user_prefs:securityPrefs, proxy, main_world_eval: options.mainWorldEval===true });
}

// 固定同一配置目录的设备预设，重启不重新抽取身份。
export async function launch(profile, proxy) {
  mkdirSync('/tmp/role-camoufox-fontconfig', { recursive: true, mode: 0o700 });
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const identityPath = profile + '/device-preset.json';
  let preset;
  try {
    preset = JSON.parse(readFileSync(identityPath, 'utf8'));
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) throw new Error('设备预设无效');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('Camoufox 设备预设损坏，停止启动', { cause: error });
    preset = getRandomPreset('linux', '158');
    if (!preset) throw new Error('Camoufox 没有可用的 Linux 设备预设');
    const temporary = identityPath + '.tmp';
    writeFileSync(temporary, JSON.stringify(preset), { mode: 0o600 });
    renameSync(temporary, identityPath);
  }
  return Camoufox({
    persistent_context: true,
    firefox_user_prefs:securityPrefs,
    main_world_eval: true,
    user_data_dir: profile,
    headless: false,
    os: 'linux',
    fingerprint_preset: preset,
    window: [1440, 900],
    viewport: null,
    locale: 'en-US',
    exclude_addons: ['UBO'],
    proxy,
  });
}
