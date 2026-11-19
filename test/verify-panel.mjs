// 验证区域面板：顶部按钮固定、底部编辑框固定、选中的框自动滚进视图
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9339;
const BASE = 'http://127.0.0.1:7788/?s=Demo1';
const profile = 'I:\\comic-canvas\\.cdp-panel';
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};
const shot = async (n) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('I:\\comic-canvas\\test\\' + n + '.png', Buffer.from(s.data, 'base64'));
};

let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + '  ' + (d || ''))); };

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
for (let i = 0; i < 40; i++) {
  const ok = await ev('!!(window.__APP && window.__APP.S.pages.length)').catch(() => false);
  if (ok) break;
  await sleep(300);
}
await sleep(1200);

const info = await ev('(() => { const p = window.__APP.S.pages.find((x) => x.regions.length > 8) || window.__APP.S.pages[0]; return { page: p.page, n: p.regions.length }; })()');
console.log('页面', info);

const geo = await ev('(() => { const S = window.__APP.S; const pi = S.pages.findIndex((x) => x.page === "' + info.page + '"); S.selPage = pi; S.selBox = -1; return { pi, n: S.pages[pi].regions.length }; })()');
console.log('geo', geo);
await sleep(300);

await ev('window.__APP.selectBox(' + geo.pi + ',' + (geo.n - 1) + ')');
await sleep(900);
const last = await ev('(() => { const sc = document.querySelector(".detail-scroll"); const row = sc.querySelector("[data-box-index=\\"' + (geo.n - 1) + '\\"]"); const er = sc.getBoundingClientRect(), rr = row.getBoundingClientRect(); const top = document.querySelector(".detail-top").getBoundingClientRect(); const foot = document.querySelector(".detail-foot"); const fr = foot && foot.getBoundingClientRect(); return { scrollTop: Math.round(sc.scrollTop), visible: rr.top >= er.top - 1 && rr.bottom <= er.bottom + 1, rowTop: Math.round(rr.top), rowBottom: Math.round(rr.bottom), scrollTopEdge: Math.round(er.top), scrollBottomEdge: Math.round(er.bottom), topButtonsTop: Math.round(top.top), footTop: fr && Math.round(fr.top) }; })()');
console.log('选最后一框', last);
check('这页有足够多的框', geo.n > 8);
check('选中的框滚进了列表视图', last.visible);
await shot('panel-last');

const topFixed = await ev('(async () => { const sc = document.querySelector(".detail-scroll"); const before = document.querySelector(".detail-top").getBoundingClientRect().top; sc.scrollTop = 0; await new Promise((r) => setTimeout(r, 300)); const after = document.querySelector(".detail-top").getBoundingClientRect().top; return { before: Math.round(before), after: Math.round(after) }; })()');
console.log('顶部', topFixed);
check('滚动后顶部按钮位置不变', topFixed.before === topFixed.after);
await shot('panel-top');

const footFixed = await ev('(async () => { const sc = document.querySelector(".detail-scroll"); const f = document.querySelector(".detail-foot"); const before = f.getBoundingClientRect().top; sc.scrollTop = sc.scrollHeight; await new Promise((r) => setTimeout(r, 400)); const after = f.getBoundingClientRect().top; return { before: Math.round(before), after: Math.round(after), inScroll: sc.contains(f) }; })()');
console.log('底部', footFixed);
check('编辑框位置固定', footFixed.before === footFixed.after);
check('编辑框不在滚动区里', footFixed.inScroll === false);
await shot('panel-bottom');

await ev('window.__APP.selectBox(' + geo.pi + ',0)');
await sleep(900);
const backTop = await ev('(() => { const sc = document.querySelector(".detail-scroll"); const row = sc.querySelector("[data-box-index=\\"0\\"]"); const er = sc.getBoundingClientRect(), rr = row.getBoundingClientRect(); const head = sc.querySelector(".box-head.sticky"); return { scrollTop: Math.round(sc.scrollTop), rowTop: Math.round(rr.top), headH: head.offsetHeight, visible: rr.top >= er.top + head.offsetHeight - 2 && rr.bottom <= er.bottom + 1 }; })()');
console.log('选第一框', backTop);
check('往回选也能滚到视图里（不被吸顶标题挡住）', backTop.visible);
await shot('panel-first');

console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
ws.close();
chrome.kill();
process.exit(fail ? 1 : 0);

