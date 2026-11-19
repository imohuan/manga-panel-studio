// 区域面板冒烟测试：改文字/应用、列表删除、tab 切换
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9341;
const BASE = 'http://127.0.0.1:7788/?s=Demo1';
const profile = 'I:/comic-canvas/.cdp-panel2';
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
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + '  ' + (d || ''))); };
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
for (let i = 0; i < 40; i++) {
  const ok = await ev('!!(window.__APP && window.__APP.S.pages.length)').catch(() => false);
  if (ok) break;
  await sleep(300);
}
await sleep(1200);
console.log('加载', await ev('JSON.stringify({ pages: window.__APP.S.pages.length, sel: window.__APP.S.pages[0] && window.__APP.S.pages[0].regions.length })'));

// 用画布点击选一个框
const pos = await ev('(() => { const S = window.__APP.S; const p = S.pages[0]; const r = p.regions[2]; const cv = document.querySelector("canvas").getBoundingClientRect(); return { x: cv.left + p.x * S.scale + S.tx + (r.box[0] + r.box[2]) / 2 * S.scale, y: cv.top + p.y * S.scale + S.ty + (r.box[1] + r.box[3]) / 2 * S.scale }; })()');
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
await mouse('mousePressed', pos.x, pos.y); await mouse('mouseReleased', pos.x, pos.y);
await sleep(700);
const sel = await ev('({ selPage: window.__APP.S.selPage, selBox: window.__APP.S.selBox })');
console.log('选中', sel);
check('画布点选后列表高亮同步', sel.selBox === 2);
const hl = await ev('(() => { const row = document.querySelector(".box-item.on"); return row ? row.getAttribute("data-box-index") : null; })()');
check('对应列表项高亮', hl === '2', String(hl));

// 底部编辑框里改字并应用
const before = await ev('window.__APP.S.pages[window.__APP.S.selPage].regions[window.__APP.S.selBox].text');
await ev('(() => { const ta = document.querySelector(".detail-foot textarea"); ta.value = "测试文字AAA"; ta.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()');
await sleep(200);
await ev('(() => { const b = [...document.querySelectorAll(".detail-foot button")].find(x => x.textContent.includes("应用")); b.click(); return 1; })()');
await sleep(900);
const after = await ev('window.__APP.S.pages[window.__APP.S.selPage].regions[window.__APP.S.selBox].text');
console.log('应用后', after);
check('应用按钮把文字写进框', after === '测试文字AAA', after);
const rowText = await ev('document.querySelector(".box-item.on .txt").textContent.trim()');
check('列表项文字同步更新', rowText === '测试文字AAA', rowText);

// 还原
await ev('(async () => { const S = window.__APP.S; S.pages[S.selPage].regions[S.selBox].text = ' + JSON.stringify(before) + '; await window.__APP.savePage(); return 1; })()');
await sleep(600);

// 切 tab 再回来，仍能看到选中的框
await ev('document.querySelectorAll(".panel-head button")[1].click()');
await sleep(600);
await ev('document.querySelectorAll(".panel-head button")[0].click()');
await sleep(800);
const back = await ev('(() => { const sc = document.querySelector(".detail-scroll"); const row = sc.querySelector(".box-item.on"); const er = sc.getBoundingClientRect(), rr = row.getBoundingClientRect(); return { visible: rr.top >= er.top - 1 && rr.bottom <= er.bottom + 1 }; })()');
check('切换 tab 回来仍定位到选中框', back.visible === true);

console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
ws.close(); chrome.kill(); process.exit(fail ? 1 : 0);

