// 只做一件事：选中一页，截右侧面板顶部按钮区，确认按钮里没有快捷键角标
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9347;
const profile = 'I:/comic-canvas/.cdp-shot-actions';
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=1200,800', '--hide-scrollbars', '--force-device-scale-factor=2', 'about:blank'],
  { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json(); break; } catch { await sleep(200); }
}
const t = list.find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => {
  const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => {
    pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    setTimeout(() => rej(new Error('timeout ' + method)), 30000);
  });
};
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:7788/?s=Demo3' });
for (let i = 0; i < 50; i++) {
  if (await ev('!!(window.__APP && window.__APP.S.pages.length)').catch(() => false)) break;
  await sleep(300);
}
await sleep(1500);
await ev('window.__APP.selectBox(0, 0), window.__APP.S.selExtra = [1], 1');
await sleep(600);

const box = await ev(`(() => { const el = document.querySelector('.detail-top');
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top - 34, width: r.width, height: r.height + 34 }; })()`);
const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2 } });
fs.writeFileSync('I:/comic-canvas/test/actions-no-kbd.png', Buffer.from(shot.data, 'base64'));
console.log('saved', JSON.stringify(box));
ws.close(); chrome.kill();
setTimeout(() => process.exit(0), 300);
