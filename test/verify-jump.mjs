import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9351;
const profile = 'I:/comic-canvas/.cdp-jump';
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=' + PORT,'--user-data-dir=' + profile,'--window-size=1400,900','--hide-scrollbars','about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 60; i++) { try { list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json(); break; } catch { await sleep(200); } }
const t = list.find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => { const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params })); return new Promise((res, rej) => { pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); setTimeout(() => rej(new Error('timeout ' + method)), 60000); }); };
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
const shot = async (n) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync('I:/comic-canvas/test/' + n + '.png', Buffer.from(s.data, 'base64')); };
const key = (k, code, vk) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
const keyUp = (k, code, vk) => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });

let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + '  ' + (d || ''))); };

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:7788/?s=Demo1' });
for (let i = 0; i < 40; i++) { const ok = await ev('!!(window.__APP && window.__APP.S.pages.length)').catch(() => false); if (ok) break; await sleep(300); }
await sleep(1000);

const pick = await ev('(() => { const S = window.__APP.S; const pi = S.pages.findIndex(p => p.page === "00003"); window.__APP.selectBox(pi, 0); return { pi, n: S.pages[pi].regions.length }; })()');
console.log('页', pick);
await sleep(400);
console.log('起始', await ev('window.__APP.S.selBox'));

await key('ArrowDown', 'ArrowDown', 40); await keyUp('ArrowDown', 'ArrowDown', 40); await sleep(400);
check('↓ 切到下一个框', (await ev('window.__APP.S.selBox')) === 1, String(await ev('window.__APP.S.selBox')));

await key('ArrowUp', 'ArrowUp', 38); await keyUp('ArrowUp', 'ArrowUp', 38); await sleep(400);
check('↑ 切回上一个框', (await ev('window.__APP.S.selBox')) === 0);

// 小键盘 2/8（NumLock 关）：key 仍是 ArrowDown/ArrowUp，code 是 Numpad2/Numpad8
await key('ArrowDown', 'Numpad2', 40); await keyUp('ArrowDown', 'Numpad2', 40); await sleep(400);
check('小键盘 2 也能下一个', (await ev('window.__APP.S.selBox')) === 1);
await key('ArrowUp', 'Numpad8', 38); await keyUp('ArrowUp', 'Numpad8', 38); await sleep(400);
check('小键盘 8 也能上一个', (await ev('window.__APP.S.selBox')) === 0);

// 从第 0 个往上 → 绕到最后一个
await key('ArrowUp', 'ArrowUp', 38); await keyUp('ArrowUp', 'ArrowUp', 38); await sleep(500);
const n = await ev('window.__APP.S.pages[' + pick.pi + '].regions.length');
check('第一个再往上绕到最后一个', (await ev('window.__APP.S.selBox')) === n - 1, String(await ev('window.__APP.S.selBox')));

// 索引输入框：输入 4 回车
await ev('(() => { const i = document.querySelector(".jump-bar input"); i.value = "4"; i.dispatchEvent(new Event("input", { bubbles: true })); i.focus(); return 1; })()');
await sleep(200);
await key('Enter', 'Enter', 13); await keyUp('Enter', 'Enter', 13); await sleep(600);
check('输入编号回车直接跳', (await ev('window.__APP.S.selBox')) === 4, String(await ev('window.__APP.S.selBox')));
const visible = await ev('(() => { const sc = document.querySelector(".detail-scroll"); const row = sc.querySelector("[data-box-index=\\"4\\"]"); const er = sc.getBoundingClientRect(), rr = row.getBoundingClientRect(); return rr.top >= er.top - 1 && rr.bottom <= er.bottom + 1; })()');
check('跳过去后列表滚到那个框', visible === true);

// 面板按钮：下一个
await ev('(() => { const b = document.querySelector(".jump-bar button[title*=\\"下一个\\"]"); b.click(); return 1; })()');
await sleep(500);
check('面板 ↓ 按钮生效', (await ev('window.__APP.S.selBox')) === 5, String(await ev('window.__APP.S.selBox')));

// 在输入框里打字不应该切换框
await ev('document.querySelector(".jump-bar input").focus()');
await sleep(100);
const beforeType = await ev('window.__APP.S.selBox');
await key('ArrowDown', 'ArrowDown', 40); await keyUp('ArrowDown', 'ArrowDown', 40); await sleep(400);
check('输入框里按方向键不切换框', (await ev('window.__APP.S.selBox')) === beforeType);

await shot('panel-jump');
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
ws.close(); chrome.kill(); process.exit(fail ? 1 : 0);

