/**
 * 一次性修复历史图片：
 *   1) 「PNG 内容配 .jpg 名字」的旧图 → 真正压成 JPEG（不然浏览器按 JPEG 解码会裂图）
 *   2) 顺便把过大的图压到 ≤1400px，历史目录不再动辄几十 MB
 *
 * 用法：node scripts/fix-history-images.mjs [会话...]   （不给会话就处理全部）
 * 只读校验 + 原地替换，不动 ops.json。可以重复跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// 路径统一走 settings.json / 环境变量，与 server 同一来源。
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
function readCfg() {
  const sf = process.env.STUDIO_SETTINGS_FILE
    || path.join(process.env.STUDIO_DATA_DIR || path.join(os.homedir(), '.manga-panel-studio'), 'settings.json');
  try { return JSON.parse(fs.readFileSync(sf, 'utf8')); } catch { return {}; }
}
const cfg = readCfg();
const canvas = cfg.canvas || {};
const DATA_HOME = process.env.STUDIO_DATA_DIR || canvas.dataDir
  || path.join(os.homedir(), '.manga-panel-studio');
const ROOT = DATA_HOME + '/sessions';
const MT = process.env.MT_ROOT || (cfg.translator || {}).projectRoot || '';
const PY = process.env.STUDIO_PYTHON || (MT ? path.join(MT, 'py310', 'python.exe') : 'python');
const CONVERT = path.join(REPO, 'server', 'compress_image.py');

const isJpeg = (f) => {
  const fd = fs.openSync(f, 'r');
  const b = Buffer.alloc(3);
  fs.readSync(fd, b, 0, 3, 0);
  fs.closeSync(fd);
  return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
};

const args = process.argv.slice(2);
const sessions = args.length ? args
  : fs.readdirSync(ROOT).filter((n) => fs.statSync(path.join(ROOT, n)).isDirectory());

let fixed = 0, skipped = 0, failed = 0, before = 0, after = 0;
for (const s of sessions) {
  const dir = path.join(ROOT, s, 'history', 'images');
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(jpe?g|png|webp)$/i.test(f)) continue;
    const src = path.join(dir, f);
    const size = fs.statSync(src).size;
    if (isJpeg(src)) { skipped++; continue; }
    const tmp = path.join(dir, `_fix-${Date.now()}.jpg`);
    try {
      execFileSync(PY, [CONVERT, src, tmp], { stdio: 'ignore' });
      const newSize = fs.statSync(tmp).size;
      fs.renameSync(tmp, src);
      fixed++;
      before += size;
      after += newSize;
      console.log(`${s}/${f}  ${(size / 1048576).toFixed(2)}MB → ${(newSize / 1024).toFixed(0)}KB`);
    } catch (e) {
      failed++;
      fs.rmSync(tmp, { force: true });
      console.log(`${s}/${f}  失败：${String(e.message).slice(0, 120)}`);
    }
  }
}
console.log(`\n修好 ${fixed} 张，跳过 ${skipped} 张（本来就是 JPEG），失败 ${failed} 张`);
if (before) console.log(`体积：${(before / 1048576).toFixed(1)}MB → ${(after / 1048576).toFixed(1)}MB`);
