// 验证：任务队列是全局的，但加载转圈只属于任务自己的画布（工作区）。
// 1) A 画布有任务时切到 B 画布，B 不能显示转圈
// 2) 切回 A 画布，A 的转圈还在；任务完成后消失
// 3) 面板统计只算当前画布，别的画布的任务单独提示
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9345;
// 7788 跑的是全局安装的 npm 包副本，不一定是最新代码。
// 这里起一个临时静态服务器：public/ 用本仓库的文件，/api 和 /events 转发给正在跑的服务。
const UP = 7788;
const LOCAL = 7801;
const PUB = path.resolve('public');
const BASE = `http://127.0.0.1:${LOCAL}/?s=Demo1`;
const profile = 'I:/comic-canvas/.cdp-wsbusy';
fs.rmSync(profile, { recursive: true, force: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2' };
const proxy = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${LOCAL}`);
  // 图片 / 历史图也由正在跑的服务提供
  if (u.pathname.startsWith('/api') || u.pathname === '/events' || u.pathname.startsWith('/s/')) {
    const up = http.request({ host: '127.0.0.1', port: UP, path: req.url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${UP}` } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
    req.pipe(up);
    return;
  }
  let f = path.join(PUB, u.pathname === '/' ? 'index.html' : u.pathname);
  if (u.pathname === '/') {
    let html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
    // 和 server/canvas.mjs 一样，把面板模板塞进去
    html = html.replace(/<!--\s*PANEL\s*-->|<aside class="panel">[\s\S]*?<\/aside>/,
      () => fs.readFileSync(path.join(PUB, 'panel.html'), 'utf8'));
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => proxy.listen(LOCAL, r));

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

let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => {
  const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => {
    pend.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    setTimeout(() => rej(new Error('timeout ' + method)), 60000);
  });
};
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)).slice(0, 700));
  return r.result.value;
};

let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + '  ' + JSON.stringify(d ?? ''))); };

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
for (let i = 0; i < 40; i++) {
  const ok = await ev('!!(window.__APP && window.__APP.S.pages.length)').catch(() => false);
  if (ok) break;
  await sleep(300);
}
await sleep(1200);
check('Demo1 已加载', (await ev('window.__APP.S.session')) === 'Demo1', await ev('window.__APP.S.session'));

const page = await ev('window.__APP.S.pages[0].page');
// 模拟后台推来一条 Demo2 的整页任务（Demo2 页也是 00003 起，页码一定会撞上）
await ev(`window.__APP.debugApplyJob({ id: 'fake-demo2', session: 'Demo2', page: '${page}', mode: 'ocr-page', status: 'running', ts: new Date().toISOString() })`);
await sleep(300);

const nowDemo1 = await ev(`({ session: window.__APP.S.session, page: '${page}', busy: window.__APP.pageIsBusy('${page}'), other: window.__APP.jobs.length })`);
console.log('Demo1 收到别的画布任务后', nowDemo1);
check('别的画布的任务不会让当前页转圈', nowDemo1.busy === false);

// 切到 Demo2：这条任务本来就属于 Demo2，应该显示转圈
await ev('window.__APP.switchSession("Demo2")');
await sleep(1200);
const nowDemo2 = await ev(`({ session: window.__APP.S.session, page: window.__APP.S.pages[0].page, busy: window.__APP.pageIsBusy(window.__APP.S.pages[0].page), mode: window.__APP.pageBusyMode(window.__APP.S.pages[0].page) })`);
console.log('切到 Demo2', nowDemo2);
check('切回任务所属画布后能看到转圈', nowDemo2.session === 'Demo2' && nowDemo2.busy === true && nowDemo2.mode === 'ocr-page');

// 再切回 Demo1：不能有转圈
await ev('window.__APP.switchSession("Demo1")');
await sleep(1200);
const back = await ev(`({ session: window.__APP.S.session, busy: window.__APP.pageIsBusy(window.__APP.S.pages[0].page), pending: window.__APP.pendingSize, pageBusy: window.__APP.pageBusySize })`);
console.log('切回 Demo1', back);
check('回到 Demo1 后没有转圈', back.busy === false);

// 面板统计只看当前画布
await ev('[...document.querySelectorAll(".panel-head .modes button")].find((b) => b.textContent.includes("任务")).click()');
await sleep(500);
// 点任务 tab 会重新拉一次任务列表，临时的假任务会被冲掉；所以拉完再放一条 Demo2 的运行中任务
await ev(`window.__APP.debugApplyJob({ id: 'fake-demo2b', session: 'Demo2', page: '${page}', mode: 'ocr-page', status: 'running', ts: new Date().toISOString() })`);
await sleep(400);
const panel = await ev(`(() => { const rows = [...document.querySelectorAll('.job-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()); const sum = document.querySelector('.jobsum b').textContent.trim(); const head = document.querySelector('.panel-body').textContent.replace(/\s+/g, ' ').trim().slice(0, 140); return { rows, runningShown: sum, head }; })()`);
console.log('面板', panel);
const otherRows = panel.rows.filter((r) => !r.includes('Demo1'));
check('别的画布的任务在行上标了画布名', panel.rows.some((r) => /\d{5}.*(demo|慈善游戏|Demo2)/.test(r))
  && otherRows.length > 0, panel.rows.slice(0, 3));
check('统计数字不把别的画布的任务算成运行中', panel.runningShown === '0', panel.runningShown);
check('面板写明统计的是当前画布', panel.head.includes('统计：当前画布 Demo1'), panel.head);
const otherBusy = await ev(`window.__APP.jobs.filter((j) => j.session !== window.__APP.S.session && ['queued','running','paused'].includes(j.status)).length`);
check('「其他画布还有任务」提示和实际任务一致',
  otherBusy === 0 ? !panel.head.includes('其他画布还有') : panel.head.includes('其他画布还有'), otherBusy);

// 任务完成后标记清掉
await ev(`window.__APP.debugApplyJob({ id: 'fake-demo2', session: 'Demo2', page: '${page}', mode: 'ocr-page', status: 'done', ts: new Date().toISOString(), result: { count: 1, ms: 5 } })`);
await sleep(300);
await ev('window.__APP.switchSession("Demo2")');
await sleep(1200);
const doneDemo2 = await ev(`window.__APP.pageIsBusy(window.__APP.S.pages[0].page)`);
check('任务完成后不再转圈', doneDemo2 === false);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
ws.close();
chrome.kill();
proxy.close();
process.exit(fail ? 1 : 0);
