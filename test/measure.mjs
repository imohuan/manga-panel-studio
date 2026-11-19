// 量真实元素高度，找出 size 不一致的根因
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9402;
const profile = 'I:\\comic-canvas\\.cdp-measure';
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--window-size=1920,1080', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); }
}
const t = list.find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
  if (m.method === 'Runtime.exceptionThrown') logs.push('[exc] ' + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
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
  return r.exceptionDetails ? { __err: JSON.stringify(r.exceptionDetails).slice(0, 200) } : r.result.value;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:7788/' });
await sleep(3200);

console.log(JSON.stringify(await ev(`(() => {
  const h = (sel) => { const el = document.querySelector(sel); if (!el) return null;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { h: Math.round(r.height * 10) / 10, w: Math.round(r.width), font: cs.fontSize, pad: cs.padding };
  };
  return {
    modeBtn: h('.modes button'),
    kitButtons: [...document.querySelectorAll('kit-button')].map(el => {
      const r = el.getBoundingClientRect();
      const inner = el.querySelector('button') || el.firstElementChild;
      const ir = inner ? inner.getBoundingClientRect() : null;
      return { h: Math.round(r.height * 10) / 10, innerH: ir ? Math.round(ir.height * 10) / 10 : null,
        text: el.textContent.trim().slice(0, 10), html: el.innerHTML.slice(0, 90) };
    }),
  };
})()`), null, 1));

console.log('\n日志:');
for (const l of logs.slice(0, 15)) console.log(' ', l);
ws.close(); chrome.kill(); process.exit(0);
