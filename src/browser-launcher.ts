import type { BrowserContext } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function browserProfile(root: string): string {
  return root + '/camoufox';
}

export async function launchBrowser(root: string, proxy?: { server: string }): Promise<BrowserContext> {
  const profile = browserProfile(root);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const launcher = await import(pathToFileURL('/opt/role-camoufox/launch.mjs').href);
  return launcher.launch(profile, proxy);
}
