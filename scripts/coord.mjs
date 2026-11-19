#!/usr/bin/env node
/**
 * 多人协作的「文件认领」小工具。
 *
 * 为什么需要它：几个对话共用一个目录改同一个项目，最容易出的事故是
 * A 改完一段代码，B 又整文件写回把它覆盖，A 发现「改了没生效」再改一次。
 * 于是规定：热文件同一时间只归一个人改。
 *
 * 用法：
 *   node scripts/coord.mjs status
 *   node scripts/coord.mjs claim public/canvas.js --owner "右侧面板 UI 优化"
 *   node scripts/coord.mjs verify public/canvas.js
 *   node scripts/coord.mjs release public/canvas.js
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, '.coord');
const STATE_FILE = path.join(STATE_DIR, 'claims.json');
const HOT_FILES = ['public/canvas.js', 'public/panel.html', 'public/index.html'];
// 后端也有共享文件：两个人同时改 server/canvas.mjs，一样会互相覆盖。
// 它不再是「抽空顺手改一下」的文件，要改先认领。
const SERVER_SRC = ['server/canvas.mjs'];
// 技能和它的 CLI 也会被两个对话同时改（一个加启动自检，一个加历史记录）。
const SHARED_DOCS = [
  'skills/manga-canvas-pipeline/SKILL.md',
  'skills/manga-canvas-pipeline/scripts/canvas_cli.py',
];
// 共享的运行时：谁要重启服务，先认领，避免别人正在测的时候被打断
const RUNTIME = ['runtime:canvas', 'runtime:ocr'];
const ALL = [...HOT_FILES, ...SERVER_SRC, ...SHARED_DOCS, ...RUNTIME];
const STALE_MINUTES = 45;

const hashOf = (rel) => {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) return null;
  return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
};
const mtimeOf = (rel) => {
  const f = path.join(ROOT, rel);
  return fs.existsSync(f) ? fs.statSync(f).mtimeMs : null;
};
const minutes = (ms) => Math.round(ms / 60000);

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { files: {} }; }
}
function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}
function norm(rel) {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!ALL.includes(p)) {
    console.error(`「${rel}」不在协作清单里。可用的名字：\n  ${ALL.join('\n  ')}`);
    process.exit(2);
  }
  return p;
}
function parseArgs(argv) {
  const [cmd, target] = argv;
  const opt = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { opt[key] = next; i++; } else opt[key] = true;
    }
  }
  return { cmd, target, opt };
}

const { cmd, target, opt } = parseArgs(process.argv.slice(2));
const state = readState();
state.files ||= {};
const now = Date.now();

function describe(rel, rec) {
  const h = hashOf(rel);
  const mt = mtimeOf(rel);
  if (!rec) return `${rel}\n  空闲（没人认领）`;
  const changed = rec.hash !== h;
  const heldFor = minutes(now - rec.at);
  const idle = mt ? minutes(now - mt) : 0;
  const flags = [];
  // 注意：认领人自己改文件也会让 hash 变化。这里只提示「和认领时不一样」，
  // 真正判断是不是别人动的，靠动手前的 verify + 读最新代码。
  if (changed) flags.push('和认领时不一样（自己刚改也算；动手前重新 claim 可刷新基线）');
  if (idle > STALE_MINUTES) flags.push(`已 ${idle} 分钟没动，可能没人管`);
  return [
    rel,
    `  认领人：${rec.owner}`,
    `  已持有 ${heldFor} 分钟；文件最后修改 ${idle} 分钟前`,
    flags.length ? `  ⚠ ${flags.join('；')}` : '  ✓ 正常',
  ].join('\n');
}

// 服务在源码改动之前就启动了，说明它跑的还是旧代码 ——
// 这是「我明明改了却没生效」的另一个常见原因，和互相覆盖一样坑人。
const SERVER_FILES = [
  { port: 7788, label: '画布服务 canvas', files: ['server/canvas.mjs', 'server/tool_routes.js', 'server/tools_helpers.js'] },
  { port: 5009, label: '识别服务 ocr', files: ['server/ocr_service.py', 'server/mask_column_ocr.py'] },
];
function runtimeReport() {
  const out = [];
  for (const s of SERVER_FILES) {
    let startedAt = null;
    try {
      const ps = `$c=Get-NetTCPConnection -LocalPort ${s.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){$p=Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if($p){$p.StartTime.ToUniversalTime().ToString('o')}}`;
      const txt = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
      startedAt = txt ? Date.parse(txt) : null;
    } catch { startedAt = null; }
    const newest = s.files
      .map((f) => ({ f, mt: mtimeOf(f) }))
      .filter((x) => x.mt)
      .sort((a, b) => b.mt - a.mt)[0];
    let line = `${s.label}（端口 ${s.port}）`;
    if (!startedAt) line += '\n  没在运行';
    else if (newest && newest.mt > startedAt) {
      line += `\n  启动于 ${new Date(startedAt).toLocaleTimeString()}，但 ${newest.f} 之后又改过`;
      line += '\n  ⚠ 跑的是旧代码：重启后改动才会生效';
    } else line += '\n  ✓ 已加载最新代码';
    out.push(line);
  }
  return out;
}

if (cmd === 'status' || !cmd) {
  console.log('热文件状态（同一时间只允许一个对话修改）：\n');
  for (const rel of HOT_FILES) console.log(describe(rel, state.files[rel]) + '\n');
  console.log('共享后端文件（同一时间只允许一个对话修改）：\n');
  for (const rel of SERVER_SRC) console.log(describe(rel, state.files[rel]) + '\n');
  console.log('技能与文档（同一时间只允许一个对话修改）：\n');
  for (const rel of SHARED_DOCS) console.log(describe(rel, state.files[rel]) + '\n');
  console.log('共享服务（重启前先认领）：\n');
  for (const rel of RUNTIME) {
    const rec = state.files[rel];
    console.log(rec ? `${rel}\n  使用者：${rec.owner}（${minutes(now - rec.at)} 分钟前认领）` : `${rel}\n  空闲`);
  }
  console.log('\n服务是否加载了最新代码：\n');
  for (const line of runtimeReport()) console.log(line + '\n');
  const others = Object.keys(state.files).filter((k) => !ALL.includes(k));
  if (others.length) console.log('旧记录：', others.join(', '));
  process.exit(0);
}

if (cmd === 'claim') {
  const rel = norm(target || '');
  const owner = typeof opt.owner === 'string' ? opt.owner : '';
  if (!owner) { console.error('缺少 --owner "你的任务名"'); process.exit(2); }
  const rec = state.files[rel];
  if (rec && rec.owner !== owner) {
    const idle = mtimeOf(rel) ? minutes(now - mtimeOf(rel)) : 0;
    const stale = idle > STALE_MINUTES && !opt.takeover;
    console.error(`认领失败：${rel} 正在由「${rec.owner}」修改（${minutes(now - rec.at)} 分钟前认领）。`);
    if (stale) console.error(`看起来已经 ${idle} 分钟没人动。确认对方不在改，再加 --takeover 接管。`);
    else console.error('请先做只读工作，或改别的文件；确实需要改，先与对方沟通。');
    process.exit(1);
  }
  state.files[rel] = { owner, at: now, hash: hashOf(rel) };
  writeState(state);
  console.log(`✓ 已认领 ${rel} → ${owner}`);
  console.log('现在可以改。只改自己负责的那一小段，改完 release。');
  process.exit(0);
}

if (cmd === 'verify') {
  const rel = norm(target || '');
  const rec = state.files[rel];
  const h = hashOf(rel);
  if (!rec) {
    console.log(`${rel} 还没人认领。动手前先 claim。`);
    process.exit(1);
  }
  if (rec.hash !== h) {
    console.error(`⚠ ${rel} 在认领之后被改过！`);
    console.error(`认领时 hash=${rec.hash}，现在是 ${h}。`);
    console.error('说明有别人动过这个文件。先 git diff 看最新内容，重新读要改的那一段，再用 apply_patch。');
    process.exit(1);
  }
  console.log(`✓ ${rel} 自认领以来没有被别人改过（owner: ${rec.owner}）`);
  process.exit(0);
}

if (cmd === 'release') {
  const rel = norm(target || '');
  const rec = state.files[rel];
  if (!rec) { console.log(`${rel} 本来就没被认领。`); process.exit(0); }
  if (typeof opt.owner === 'string' && rec.owner !== opt.owner) {
    console.error(`释放失败：${rel} 属于「${rec.owner}」，不是「${opt.owner}」。`);
    process.exit(1);
  }
  delete state.files[rel];
  writeState(state);
  console.log(`✓ 已释放 ${rel}`);
  process.exit(0);
}

console.error('用法：node scripts/coord.mjs <status|claim|verify|release> [文件] [--owner 名字] [--takeover]');
process.exit(2);
