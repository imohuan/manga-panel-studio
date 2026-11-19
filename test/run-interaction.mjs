// 验证：选中图片出面板、识别框实时结果、SSE 回推
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const BASE = 'http://127.0.0.1:7788';
const profile = 'I:\\comic-canvas\\.cdp-int';
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1600,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let list;
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); }
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
    setTimeout(() => rej(new Error('timeout ' + method)), 60000);
  });
};
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result.value;
};
const shot = async (n) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`I:\\comic-canvas\\test\\${n}.png`, Buffer.from(s.data, 'base64'));
};
const click = async (x, y, btn = 'left') => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: btn, buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: btn, buttons: 0, clickCount: 1 });
  await sleep(300);
};

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`)); };

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
await sleep(2600);

console.log('\n[1] 点选图片 → 面板');
const center = await ev(`(() => { const p = window.__S.pages[0];
  return { x: (p.x + p.width / 2) * window.__S.scale + window.__S.tx,
           y: (p.y + p.height * 0.75) * window.__S.scale + window.__S.ty, page: p.page }; })()`);
await click(center.x, center.y);
const panel = await ev(`({ open: document.getElementById('panel').classList.contains('open'),
  title: document.getElementById('panelTitle').textContent,
  hasThumb: !!document.querySelector('#panelBody img.thumb'),
  selPage: window.__S.selPage })`);
check('点图片打开右侧面板', panel.open);
check('面板显示页码', panel.title === center.page, panel.title);
check('面板有缩略图', panel.hasThumb);

console.log('\n[2] 框选模式新建框');
await ev("document.getElementById('btnFit').click()");
await sleep(400);
const before = await ev('window.__S.pages[0].regions.length');
const spot = await ev(`(() => { const p = window.__S.pages[0];
  return { x: (p.x + 40) * window.__S.scale + window.__S.tx,
           y: (p.y + 40) * window.__S.scale + window.__S.ty }; })()`);
await ev("document.getElementById('modeBox').click()");
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', buttons: 1, clickCount: 1 });
for (let i = 1; i <= 5; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x + i * 8, y: spot.y + i * 8, button: 'left', buttons: 1 });
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x + 40, y: spot.y + 40, button: 'left', buttons: 0 });
await sleep(300);
const afterNew = await ev('window.__S.pages[0].regions.length');
check('空白拖动新建框', afterNew === before + 1, `${before} -> ${afterNew}`);

console.log('\n[3] 识别框模式（真实调用后台 OCR）');
const target = await ev(`(() => { const p = window.__S.pages[0];
  return { x: (p.x + 1080) * window.__S.scale + window.__S.tx,
           y: (p.y + 640) * window.__S.scale + window.__S.ty,
           x2: (p.x + 1180) * window.__S.scale + window.__S.tx,
           y2: (p.y + 900) * window.__S.scale + window.__S.ty }; })()`);

await ev("document.getElementById('modeDetect').click()");
const countBefore = await ev('window.__S.pages[0].regions.length');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 });
for (let i = 1; i <= 6; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', button: 'left', buttons: 1,
    x: target.x + ((target.x2 - target.x) * i) / 6, y: target.y + ((target.y2 - target.y) * i) / 6,
  });
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x2, y: target.y2, button: 'left', buttons: 0 });

console.log('  等待后台 OCR…');
let countAfter = countBefore, changed = false;
for (let i = 0; i < 40; i++) {
  await sleep(1500);
  countAfter = await ev('window.__S.pages[0].regions.length');
  const hasR = await ev("window.__S.pages[0].regions.some(r => r.source === 'redetect')");
  if (hasR) { changed = true; break; }
}
check('识别框回填了新框', changed, `数量 ${countBefore} -> ${countAfter}`);

const redetected = await ev(`window.__S.pages[0].regions.filter(r => r.source === 'redetect').map(r => r.text.slice(0, 20))`);
console.log('  识别到的文字:', JSON.stringify(redetected));

await shot('interaction');
ws.close();
chrome.kill();
await sleep(300);
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
