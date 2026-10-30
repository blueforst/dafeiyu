// 仅用于无外网、临时 profile 的浏览器验收。正式启动器不启用 Marionette。
// 按 Mozilla Marionette 协议读取父进程中的有效偏好，避免把未落入 prefs.js 的默认值误判为未生效。
import assert from 'node:assert/strict';
import {connect} from 'node:net';

export async function readEffectiveSecurityPrefs() {
  const socket = connect({host: '127.0.0.1', port: 2828});
  let bytes = Buffer.alloc(0), waiting, failure, sequence = 0;
  const messages = [];
  function fail(error) { failure = error; waiting?.reject(error); waiting = undefined; }
  socket.setTimeout(8000, () => socket.destroy(new Error('安全偏好读回超时')));
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('安全偏好连接已关闭')));
  socket.on('data', chunk => {
    try {
      bytes = Buffer.concat([bytes, chunk]);
      while (true) {
        const colon = bytes.indexOf(58);
        if (colon < 0) break;
        const length = Number(bytes.subarray(0, colon).toString());
        assert.ok(Number.isInteger(length) && length > 0 && length < 1048576);
        if (bytes.length < colon + 1 + length) break;
        const message = JSON.parse(bytes.subarray(colon + 1, colon + 1 + length).toString());
        bytes = bytes.subarray(colon + 1 + length);
        if (waiting) { const current = waiting; waiting = undefined; current.resolve(message); }
        else messages.push(message);
      }
    } catch (error) { socket.destroy(error); }
  });
  const receive = () => failure ? Promise.reject(failure) : messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => { waiting = {resolve, reject}; });
  async function command(name, parameters = {}) {
    const id = ++sequence, body = JSON.stringify([0, id, name, parameters]);
    socket.write(Buffer.byteLength(body) + ':' + body);
    const response = await receive();
    assert.equal(response[0], 1); assert.equal(response[1], id);
    if (response[2]) throw new Error(JSON.stringify(response[2]));
    return response[3];
  }
  try {
    assert.equal((await receive()).marionetteProtocol, 3);
    await command('WebDriver:NewSession', {capabilities: {alwaysMatch: {}}});
    await command('Marionette:SetContext', {value: 'chrome'});
    const result = await command('WebDriver:ExecuteScript', {
      script: 'return {server:Services.prefs.getStringPref("services.settings.server"),blocklist:Services.prefs.getBoolPref("extensions.blocklist.enabled")};',
      args: [], newSandbox: true, sandbox: 'system', line: 1, filename: 'effective-security-prefs',
    });
    return result.value;
  } finally { socket.destroy(); }
}
