// 端到端 UI 测试：无头 Chrome + CDP，断言真实行为
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;
const BASE = 'http://127.0.0.1:7788';
const profile = 'I:\\comic-canvas\\.cdp-test';
const shots = 'I:\\comic-canvas\\test';
fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(shots, { recursive: true });

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--window-size=1600,900', '--hide-scrollbars', 'about:blank'],
  { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); }
}
if (!list) { console.error('FAIL 无法启动 Chrome'); process.exit(1); }

const target = list.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  events.push(m);
});
const send = (method, params = {}) => {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => {
    pending.set(mid, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)));
    setTimeout(() => rej(new Error(`超时 ${method}`)), 25000);
  });
};
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${shots}\\${name}.png`, Buffer.from(s.data, 'base64'));
};
const mouse = (type, x, y, button = 'left') => send('Input.dispatchMouseEvent', {
  type, x, y, button, buttons: type === 'mouseReleased' ? 0 : (button === 'left' ? 1 : 2), clickCount: 1,
});
const drag = async (x1, y1, x2, y2, button = 'left') => {
  await mouse('mousePressed', x1, y1, button);
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / 6, y: y1 + ((y2 - y1) * i) / 6,
      button, buttons: button === 'left' ? 1 : 2,
    });
  }
  await mouse('mouseReleased', x2, y2, button);
  await sleep(250);
};

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.navigate', { url: `${BASE}/` });
await sleep(2600);

console.log('\n[1] 画布基础');
const base = await ev(`({ w: document.getElementById('cv').clientWidth,
  h: document.getElementById('cv').clientHeight, iw: innerWidth, ih: innerHeight })`);
check('canvas 撑满视口', base.w >= base.iw - 2 && base.h >= base.ih - 2, JSON.stringify(base));

const pages = await ev(`window.__S.pages.map(p => ({ page: p.page, x: p.x, y: p.y, w: p.width, h: p.height, n: p.regions.length }))`);
check('8 页全部加载', pages.length === 8, `实际 ${pages.length}`);
check('图片都有尺寸', pages.every((p) => p.w > 0 && p.h > 0));
check('每页都有框', pages.every((p) => p.n > 0), JSON.stringify(pages.map((p) => p.n)));

console.log('\n[2] 布局不重叠');
let overlap = null;
for (let i = 0; i < pages.length; i++) {
  for (let j = i + 1; j < pages.length; j++) {
    const a = pages[i], b = pages[j];
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    if (ix > 0 && iy > 0) overlap = `${a.page}/${b.page}`;
  }
}
check('图片互不重叠', !overlap, String(overlap));

const rows = [...new Set(pages.map((p) => p.y))];
if (rows.length > 1) {
  const firstRowBottom = Math.max(...pages.filter((p) => p.y === rows[0]).map((p) => p.y + p.h));
  check('行间留出标题空间', rows[1] - firstRowBottom >= 20, `间距 ${rows[1] - firstRowBottom}px`);
}

console.log('\n[3] 缩放与平移');
const z0 = await ev('window.__S.scale');
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 400, deltaX: 0, deltaY: -240 });
await sleep(200);
const z1 = await ev('window.__S.scale');
check('滚轮放大', z1 > z0, `${z0} -> ${z1}`);

const t0 = await ev('({x: window.__S.tx, y: window.__S.ty})');
await drag(1100, 700, 1000, 640, 'middle');
const t1 = await ev('({x: window.__S.tx, y: window.__S.ty})');
check('中键拖动平移', Math.abs(t1.x - t0.x) > 20 || Math.abs(t1.y - t0.y) > 20,
  `${JSON.stringify(t0)} -> ${JSON.stringify(t1)}`);

await ev('window.__S.tx=0; window.__S.ty=0; window.__S.scale=1; window.__S.pages.forEach((p,i)=>{p.regions=p.regions.slice(0,3)}); 1');
await sleep(100);

console.log('\n[4] 右键删除框');
await ev("document.getElementById('btnFit').click()");
await sleep(400);
const before = await ev('window.__S.pages.reduce((a,p)=>a+p.regions.length,0)');
const firstBox = await ev(`(() => { const p = window.__S.pages[0]; const r = p.regions[0];
  return { sx: p.x * window.__S.scale + window.__S.tx + (r.box[0] + r.box[2]) / 2 * window.__S.scale,
           sy: p.y * window.__S.scale + window.__S.ty + (r.box[1] + r.box[3]) / 2 * window.__S.scale }; })()`);
await mouse('mousePressed', firstBox.sx, firstBox.sy, 'right');
await mouse('mouseReleased', firstBox.sx, firstBox.sy, 'right');
await sleep(300);
const after = await ev('window.__S.pages.reduce((a,p)=>a+p.regions.length,0)');
check('右键点框即删除', after === before - 1, `${before} -> ${after}`);

console.log('\n[5] 离屏裁剪');
const hidden = await ev(`(() => {
  // 把所有图推很远，看绘制函数是否跳过
  window.__S.pages.forEach(p => { p.x += 90000; });
  let drawn = 0;
  const orig = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...a) { drawn++; return orig.apply(this, a); };
  if (window.__draw) window.__draw();
  CanvasRenderingContext2D.prototype.drawImage = orig;
  return drawn;
})()`);
check('离屏图片不绘制', hidden === 0, `drawImage 调用 ${hidden} 次`);

// 复位，拍一张可读的最终图
await ev('window.__S.pages.forEach(p => { p.x -= 90000; }); window.__draw(); 1');
await ev("document.getElementById('btnFit').click()");
await sleep(600);

await shot('final');

ws.close();
chrome.kill();
await sleep(300);
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
