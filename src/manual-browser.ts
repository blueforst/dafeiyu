import { launchBrowser } from './browser-launcher.js';
import { browserProxy } from './browser.js';
import { redact } from './config.js';

async function main() {
  const context = await launchBrowser(process.env.MANUAL_PROFILE_DIR || '/profile/manual-login-check', browserProxy(process.env.BROWSER_PROXY_SERVER));
  const page = context.pages()[0] || await context.newPage();
  context.on('close', () => process.exit(0));
  process.on('SIGTERM', () => { void context.close(); });
  await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
}
main().catch(error => { console.error(redact(error)); process.exit(1); });
