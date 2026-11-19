import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9502;
const profile = 'I:\\comic-canvas\\.mini';
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--window-size=900,400', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); }
}
const t = list.find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const msgs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') msgs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 500));
  if (m.method === 'Runtime.exceptionThrown') msgs.push('[exc] ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 500));
});
const send = (method, params = {}) => {
  const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => {
    pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    setTimeout(() => rej(new Error('timeout ' + method)), 20000);
  });
};
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  return r.exceptionDetails ? '__ERR__ ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:7788/mini.html' });
await sleep(2600);
console.log('log:', await ev('JSON.stringify(window.__log)'));
console.log('html:', await ev(`document.getElementById('app').innerHTML.slice(0,300)`));
console.log('count:', await ev(`document.querySelectorAll('kit-button').length`));
console.log('messages:');
for (const m of msgs.slice(0, 10)) console.log('  ', m);
ws.close(); chrome.kill(); process.exit(0);
