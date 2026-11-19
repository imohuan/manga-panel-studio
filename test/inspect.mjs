import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9503;
const profile = 'I:\\comic-canvas\\.insp';
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });
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
  if (m.method === 'Runtime.consoleAPICalled') msgs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 400));
  if (m.method === 'Runtime.exceptionThrown') msgs.push('[exc] ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 400));
  if (m.method === 'Log.entryAdded') msgs.push('[log] ' + m.params.entry.level + ' ' + String(m.params.entry.text).slice(0, 300));
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
  return r.exceptionDetails ? '__ERR__ ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : r.result.value;
};
await send('Log.enable');
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:7788/' });
await sleep(3200);

console.log('__APP:', await ev(`typeof window.__APP`));
console.log('__APP:', await ev(`typeof window.__APP`));
console.log('toolbar html:', await ev(`document.querySelector('.mode-bar')?.innerHTML.slice(0,200)`));
console.log('----');
console.log('mounted app?', await ev(`!!document.querySelector('#app').__vue_app__`));
console.log('comp names sample:', await ev(`Object.keys(document.querySelector('#app').__vue_app__._context.components).slice(0,6).join(',')`));
console.log('msgs:');
for (const m of msgs.slice(0, 12)) console.log('  ', m);
ws.close(); chrome.kill(); process.exit(0);
