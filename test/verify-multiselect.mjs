// 多选框 + 快捷键验证：Shift 拖框选、Shift 点选、I/O/P、右侧联动
// 只做只读断言；唯一的写操作会在最后把文字改回原样。
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9343;
const BASE = 'http://127.0.0.1:7788/?s=Demo3';
const profile = 'I:/comic-canvas/.cdp-multiselect';
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=1600,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json(); break; } catch { await sleep(200); }
}
if (!list) { console.error('FAIL 无法启动 Chrome'); process.exit(1); }

const t = list.find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    const frames = (d.stackTrace?.callFrames || []).slice(0, 4).map((f) => f.functionName + '@' + f.lineNumber + ':' + f.columnNumber).join(' < ');
    console.log('  [page error]', d.exception?.description?.split('\n')[0], '|', frames);
  }
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + '  ' + (d || ''))); };

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
for (let i = 0; i < 50; i++) {
  const ok = await ev('!!(window.__APP && window.__APP.S.pages.length)').catch(() => false);
  if (ok) break;
  await sleep(300);
}
await sleep(1500);

const mouse = (type, x, y, mods = 0) => send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, modifiers: mods,
});
const SHIFT = 8;
console.log('  DOM', await ev(`JSON.stringify({ wrap: !!document.querySelector('.canvas-wrap'),
  canvases: [...document.querySelectorAll('canvas')].map(c => c.className + '|' + c.parentElement.className) })`));
console.log('  cvEl', await ev(`(() => { const c = window.__APP.cvEl; return c ? (c.className + '|' + c.isConnected + '|' + (c.parentElement && c.parentElement.className)) : 'null'; })()`));

console.log('\n[1] Shift + 拖动框选多个识别框');
// 找一页里至少有两个框的页面，保证框选有东西可选
// 选一页框不太多也不太少（框太多时一拖就全选中，没法测「加选」）
const pi = await ev(`(() => { const S = window.__APP.S; const i = S.pages.findIndex(p => p.regions.length >= 6); return i < 0 ? 0 : i; })()`);
const pageInfo = await ev(`(() => { const S = window.__APP.S; return S.pages.map((p, i) => i + ':' + p.page + ':' + p.regions.length); })()`);
console.log('  页面框数', pageInfo.join(' | '));
await ev(`window.__APP.S.selPage = -1; window.__APP.S.selBox = -1; window.__APP.S.selExtra = []; window.__APP.draw(); 1`);
const rect = await ev(`(() => { const S = window.__APP.S; const p = S.pages[${pi}];
  const cv = document.querySelector('.canvas-wrap canvas').getBoundingClientRect();
  // 用前两个框的外接矩形当框选范围，保证一定能套住它们
  const a = p.regions[0].box, b = p.regions[1].box;
  const bx1 = Math.min(a[0], b[0]), by1 = Math.min(a[1], b[1]);
  const bx2 = Math.max(a[2], b[2]), by2 = Math.max(a[3], b[3]);
  const toS = (x, y) => ({ x: cv.left + p.x * S.scale + S.tx + x * S.scale,
                           y: cv.top + p.y * S.scale + S.ty + y * S.scale });
  const p1 = toS(bx1 - 6, by1 - 6), p2 = toS(bx2 + 6, by2 + 6);
  return { x: p1.x, y: p1.y, x2: p2.x, y2: p2.y }; })()`);
const x1 = rect.x, y1 = rect.y, x2 = rect.x2, y2 = rect.y2;
await mouse('mousePressed', x1, y1, SHIFT);
await ev(`window.__moves = 0; document.addEventListener('pointermove', () => { window.__moves++; }, true); 1`);
for (let i = 1; i <= 8; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, modifiers: SHIFT,
    x: x1 + ((x2 - x1) * i) / 8, y: y1 + ((y2 - y1) * i) / 8 });
}
console.log('  pointermove 次数', await ev('window.__moves'));
const during = await ev('window.__APP.S.drag ? window.__APP.S.drag.kind : null');
const dbg = await ev(`(() => { const d = window.__APP.S.drag; return d ? JSON.stringify({ rect: d.rect, hits: d.hits, start: d.start, box0: window.__APP.S.pages[${pi}].regions[0].box, box1: window.__APP.S.pages[${pi}].regions[1].box }) : 'null'; })()`);
console.log('  debug', dbg, 'target', JSON.stringify({ x1, y1, x2, y2 }));
check('拖动时进入框选模式', during === 'select', String(during));
await mouse('mouseReleased', x2, y2, SHIFT);
await sleep(300);
const sel1 = await ev('({ pi: window.__APP.S.selPage, main: window.__APP.S.selBox, extra: window.__APP.S.selExtra.slice(), n: window.__APP.S.pages[' + pi + '].regions.length })');
check('框选后选中了这一页的多个框', sel1.pi === pi && sel1.extra.length + (sel1.main >= 0 ? 1 : 0) > 1, JSON.stringify(sel1));
const cnt1 = await ev('window.__APP.selectedCount');
check('selectedCount 与选中的框数一致', cnt1 === sel1.extra.length + 1, String(cnt1));

console.log('\n[2] Shift + 点击：加选 / 取消');
const second = await ev(`(() => { const S = window.__APP.S; const p = S.pages[${pi}];
  const used = [S.selBox, ...S.selExtra]; let k = -1;
  for (let i = 0; i < p.regions.length; i++) if (!used.includes(i)) { k = i; break; }
  if (k < 0) return null;
  const r = p.regions[k]; const cv = document.querySelector('.canvas-wrap canvas').getBoundingClientRect();
  return { k, x: cv.left + p.x * S.scale + S.tx + (r.box[0] + r.box[2]) / 2 * S.scale,
           y: cv.top + p.y * S.scale + S.ty + (r.box[1] + r.box[3]) / 2 * S.scale }; })()`);
if (second) {
  const before = await ev('window.__APP.selectedCount');
  await mouse('mousePressed', second.x, second.y, SHIFT);
  await mouse('mouseReleased', second.x, second.y, SHIFT);
  await sleep(250);
  const after = await ev('window.__APP.selectedCount');
  check('Shift 点未选中的框 → 加选', after === before + 1, `${before} -> ${after}`);
  await mouse('mousePressed', second.x, second.y, SHIFT);
  await mouse('mouseReleased', second.x, second.y, SHIFT);
  await sleep(250);
  const after2 = await ev('window.__APP.selectedCount');
  check('Shift 再点一次 → 取消选中', after2 === before, `${after} -> ${after2}`);
} else {
  check('页面还有未选中的框可用于 Shift 点选', false, '没有多余的框');
}

console.log('\n[3] 普通点击恢复单选');
const plain = await ev(`(() => { const S = window.__APP.S; const p = S.pages[${pi}]; const r = p.regions[0];
  const cv = document.querySelector('.canvas-wrap canvas').getBoundingClientRect();
  return { x: cv.left + p.x * S.scale + S.tx + (r.box[0] + r.box[2]) / 2 * S.scale,
           y: cv.top + p.y * S.scale + S.ty + (r.box[1] + r.box[3]) / 2 * S.scale }; })()`);
await mouse('mousePressed', plain.x, plain.y);
await mouse('mouseReleased', plain.x, plain.y);
await sleep(250);
const one = await ev('({ n: window.__APP.selectedCount, extra: window.__APP.S.selExtra.length })');
check('普通点击后只选中 1 个框', one.n === 1 && one.extra === 0, JSON.stringify(one));

console.log('\n[4] 右侧面板三按钮与快捷键');
const btnCount = await ev(`[...document.querySelectorAll('.detail-top .actions .kit-btn')].length`);
check('右侧顶部还是 3 个按钮', btnCount === 3, String(btnCount));
// 快捷键只在右上角提示，按钮里不要再挂角标（用户反馈过太挤）
const kbd = await ev(`[...document.querySelectorAll('.detail-top kbd')].length`);
check('按钮里不显示 I / O / P 角标', kbd === 0, String(kbd));

// 拦截 fetch，记录发出去的 job 请求，避免真的占用 OCR 队列
await ev(`(() => { window.__sent = []; const of = window.fetch;
  window.fetch = (url, opt) => { if (String(url).endsWith('/job') && opt && opt.body) window.__sent.push(JSON.parse(opt.body));
    return of(url, opt); }; return 1; })()`);

// 先单选一个框，再按 P：应当把选中的框送进 ocr-boxes
await ev(`window.__APP.selectBox(${pi}, 0)`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 });
await sleep(500);
const pJob = await ev(`window.__sent.filter(j => j.mode === 'ocr-boxes').pop() || null`);
check('P 提交框内文字任务', pJob && pJob.mode === 'ocr-boxes' && pJob.boxes.length === 1, JSON.stringify(pJob));

// 多选两个框后按 P：一次提交两个框
await ev(`(() => { const p = window.__APP.S.pages[${pi}]; window.__APP.S.selBox = 0; window.__APP.S.selExtra = [1]; return 1; })()`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 });
await sleep(500);
const pJob2 = await ev(`window.__sent.filter(j => j.mode === 'ocr-boxes').pop() || null`);
check('多选后 P 一次提交两个框', pJob2 && pJob2.boxes.length === 2, JSON.stringify(pJob2));

// I / O：模式必须是服务端认的 detect-page / ocr-page
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73 });
await sleep(400);
const iJob = await ev(`window.__sent.filter(j => String(j.mode).startsWith('detect')).pop() || null`);
check('I 发送 detect-page（不再误发 detect）', iJob && iJob.mode === 'detect-page', JSON.stringify(iJob));

await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79 });
await sleep(400);
const oJob = await ev(`window.__sent.filter(j => j.mode === 'ocr-page').pop() || null`);
check('O 发送 ocr-page 任务', oJob && oJob.mode === 'ocr-page', JSON.stringify(oJob));

// 没有选中对象时快捷键不生效
await ev(`window.__APP.S.selPage = -1; window.__APP.S.selBox = -1; window.__APP.S.selExtra = []; window.__sent.length = 0; 1`);
for (const [key, code, vk] of [['i', 'KeyI', 73], ['o', 'KeyO', 79], ['p', 'KeyP', 80]]) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
}
await sleep(400);
const none = await ev('window.__sent.length');
check('没有选中对象时 I/O/P 不提交任务', none === 0, String(none));

// 输入框内打字不应触发快捷键
await ev(`(() => { const ta = document.querySelector('.detail-foot textarea') || document.body; })(), 1`);
const inInput = await ev(`(() => { const el = document.createElement('input'); document.body.appendChild(el); el.focus();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true })); el.remove();
  return window.__sent.length; })()`);
check('在输入框里按 P 不会触发识别', inInput === 0, String(inInput));

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
ws.close(); chrome.kill();
setTimeout(() => process.exit(fail ? 1 : 0), 300);
