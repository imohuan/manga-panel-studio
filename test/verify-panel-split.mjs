// 右侧面板拖拽宽度：实测拖拽、上下限、记忆、双击复位、画布跟着变
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9342;
const BASE = 'http://127.0.0.1:7788/?s=Demo1';
const profile = 'I:/comic-canvas/.cdp-split';
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=1400,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json(); break; } catch { await sleep(200); }
}
const t = list.find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => {
  const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => {
    pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    setTimeout(() => rej(new Error('timeout ' + method)), 60000);
  });
};
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + '  ' + (d || ''))); };
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
for (let i = 0; i < 40; i++) {
  if (await ev('location.href.startsWith("http")').catch(() => false)) break;
  await sleep(200);
}
await ev('localStorage.removeItem("canvas.panelWidth")');
await send('Page.reload');
for (let i = 0; i < 40; i++) {
  if (await ev('!!document.querySelector(".panel-resizer") && !!(window.__APP && window.__APP.S.pages.length)').catch(() => false)) break;
  await sleep(300);
}
await sleep(1000);

const info = () => ev('(() => { const p = document.querySelector("aside.panel").getBoundingClientRect(); const c = document.querySelector("canvas").getBoundingClientRect(); const r = document.querySelector(".panel-resizer").getBoundingClientRect(); return { panel: p.width, canvas: c.width, rz: { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }, max: window.__PANEL_SPLIT__.max() }; })()');
let s = await info();
console.log('初始', JSON.stringify(s));
check('默认宽度 336', Math.abs(s.panel - 336) < 1.5, String(s.panel));
check('拖拽条 8px 且在画布与面板之间', Math.abs(s.rz.w - 8) < 1 && s.rz.x > 0, JSON.stringify(s.rz));

const drag = async (fromX, toX, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX + (toX - fromX) * i / 8, y, button: 'left', buttons: 1 });
    await sleep(30);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(300);
};

const beforeCanvas = s.canvas;
await drag(s.rz.x, s.rz.x - 120, s.rz.y);
s = await info();
console.log('拖宽后', JSON.stringify(s));
check('往左拖面板变宽约 120px', Math.abs(s.panel - 456) < 6, String(s.panel));
check('画布同步变窄', s.canvas < beforeCanvas - 100, String(s.canvas));
check('宽度写进 localStorage', Math.abs(parseFloat(await ev('localStorage.getItem("canvas.panelWidth")')) - s.panel) < 2);

await drag(s.rz.x, s.rz.x + 600, s.rz.y);
s = await info();
check('最小宽度停在 280', Math.abs(s.panel - 280) < 1.5, String(s.panel));
check('画布没有被压成负宽', s.canvas > 0, String(s.canvas));

await drag(s.rz.x, s.rz.x - 1200, s.rz.y);
s = await info();
check('最大宽度停在上限', Math.abs(s.panel - s.max) < 2, s.panel + ' / ' + s.max);
check('上限不超过 720', s.panel <= 720.5, String(s.panel));

const saved = s.panel;
await send('Page.reload');
for (let i = 0; i < 40; i++) {
  if (await ev('!!document.querySelector(".panel-resizer") && !!(window.__APP && window.__APP.S.pages.length)').catch(() => false)) break;
  await sleep(300);
}
await sleep(800);
s = await info();
check('刷新后保持宽度', Math.abs(s.panel - saved) < 2, s.panel + ' / ' + saved);

await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s.rz.x, y: s.rz.y, button: 'left', buttons: 1, clickCount: 2 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s.rz.x, y: s.rz.y, button: 'left', buttons: 0, clickCount: 2 });
await sleep(400);
s = await info();
check('双击恢复 336', Math.abs(s.panel - 336) < 1.5, String(s.panel));

// 窄窗口：宽度自动夹到窗口的 60% 以内，画布仍有空间
await ev('window.__PANEL_SPLIT__.set(720)');
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
await sleep(600);
s = await info();
console.log('窗口 900 时', JSON.stringify(s));
check('窄窗口自动重夹到 60% 以内', s.panel <= 900 * 0.6 + 1, String(s.panel));
check('窄窗口画布还在', s.canvas > 200, String(s.canvas));
await send('Emulation.clearDeviceMetricsOverride');
await sleep(400);

// 窄面板下四个 tab 不折行：按钮高度都等于 modes 高度
const tabs = await ev('(() => { const box = document.querySelector(".panel-head .modes"); const bs = [...box.querySelectorAll("button")]; const h = box.getBoundingClientRect().height; return { count: bs.length, ok: bs.every(b => Math.abs(b.getBoundingClientRect().height - h) < 1.5), labels: bs.map(b => b.textContent.trim()) }; })()');
console.log('tab', JSON.stringify(tabs));
check('四个 tab 在一行不折行', tabs.count === 4 && tabs.ok, JSON.stringify(tabs));

// 最小宽度 280 时文字也保留，不靠隐藏文字硬塞
await ev('window.__PANEL_SPLIT__.set(280)');
await sleep(300);
const narrow = await ev('(() => { const box = document.querySelector(".panel-head .modes"); const bs = [...box.querySelectorAll("button")]; const t = bs.map(b => b.innerText.replace(/\s+/g, "")); return { t, fits: box.scrollWidth <= box.clientWidth + 1, h: box.getBoundingClientRect().height, same: bs.every(b => Math.abs(b.getBoundingClientRect().height - box.getBoundingClientRect().height) < 1.5) }; })()');
console.log('280px tab', JSON.stringify(narrow));
check('280px 时四个 tab 文字都在且不折行',
  narrow.t.length === 4 && narrow.t.every(s => s.length > 0) && narrow.fits && narrow.same, JSON.stringify(narrow));
await ev('window.__PANEL_SPLIT__.set(336)');
await sleep(300);

// 日志浮层跟着面板宽度走
const logs = await ev('(() => { const el = document.querySelector(".logs"); const panel = document.querySelector("aside.panel").getBoundingClientRect(); if (!el) return { skip: true }; const r = el.getBoundingClientRect(); return { gap: window.innerWidth - r.right, panel: panel.width, ok: Math.abs((window.innerWidth - r.right) - panel.width - 12) < 2 }; })()');
if (!logs.skip) check('日志浮层贴着面板左边 12px', logs.ok, JSON.stringify(logs));

check('控制台无报错', errors.length === 0, errors.join(' | '));
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
ws.close(); chrome.kill(); process.exit(fail ? 1 : 0);
