#!/usr/bin/env node
// manga-panel-studio 命令行入口
//   manga-panel-studio            启动画布服务（7788，前台）
//   manga-panel-studio check      检查两个服务状态
//   manga-panel-studio ocr        启动 Python OCR 服务（5009）
//   manga-panel-studio start-all  同时启动画布 + OCR
//   manga-panel-studio help       帮助
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cmd = process.argv[2] || 'start';

// Python 解释器：环境变量 > ~/.manga-panel-studio/settings.json > PATH
function resolvePython() {
  if (process.env.STUDIO_PYTHON) return process.env.STUDIO_PYTHON;
  try {
    const sf = process.env.STUDIO_SETTINGS_FILE
      || path.join(process.env.STUDIO_DATA_DIR || path.join(os.homedir(), '.manga-panel-studio'), 'settings.json');
    const mt = (JSON.parse(fs.readFileSync(sf, 'utf8')).translator || {}).projectRoot || '';
    if (mt) {
      for (const sub of ['py310/python.exe', 'venv/Scripts/python.exe', '.venv/Scripts/python.exe', 'python.exe', 'bin/python']) {
        const c = path.join(mt, sub);
        if (fs.existsSync(c)) return c;
      }
    }
  } catch {}
  return 'python';
}

const mtRoot = () => {
  try {
    const sf = process.env.STUDIO_SETTINGS_FILE
      || path.join(process.env.STUDIO_DATA_DIR || path.join(os.homedir(), '.manga-panel-studio'), 'settings.json');
    return (JSON.parse(fs.readFileSync(sf, 'utf8')).translator || {}).projectRoot || '';
  } catch { return ''; }
};

// 数据根目录：环境变量 > settings.canvas.dataDir > ~/.manga-panel-studio。
// 和 server/tools_helpers.js 同一套优先级，打印出来的路径才是服务真正在用的那个。
function dataHome() {
  if (process.env.STUDIO_DATA_DIR) return process.env.STUDIO_DATA_DIR;
  try {
    const sf = process.env.STUDIO_SETTINGS_FILE
      || path.join(os.homedir(), '.manga-panel-studio', 'settings.json');
    const dir = ((JSON.parse(fs.readFileSync(sf, 'utf8')).canvas) || {}).dataDir || '';
    if (dir) return dir;
  } catch {}
  return path.join(os.homedir(), '.manga-panel-studio');
}

function banner(tag) { console.log('────────── ' + tag + ' ──────────'); }


// 启动 OCR 并等它真的起来：失败时把真实原因说清楚，不留给用户瞎猜。
async function startOcr({ foreground = false } = {}) {
  const py = resolvePython();
  const script = path.join(ROOT_DIR, 'server', 'ocr_service.py');
  if (!fs.existsSync(script)) {
    console.log('还没有 OCR 服务代码文件，当前是旧版本包。先升级：npm i -g manga-panel-studio@latest');
    return false;
  }

  // 1) 端口已被占用：先判断那是谁，是我们自己的就直接复用，是别人的就报清楚。
  const already = await get('http://127.0.0.1:5009/health');
  if (already.ok) {
    console.log('OCR 服务已经在运行（5009 健康），直接复用，不重复启动。');
    return true;
  }

  // 2) 端口被非 OCR 进程占着：这会造成 [Errno 10048]，必须提前说清楚。
  const busy = await isPortListening(5009);
  if (busy) {
    console.log('端口 5009 被别的进程占用了（多半是上次没退干净的 OCR 进程）。');
    console.log('  查看占用：netstat -ano | findstr :5009');
    console.log('  结束占用：taskkill /PID <上面查到的PID> /F');
    console.log('  再重试：manga-panel-studio ocr');
    return false;
  }

  // 3) Python 环境检查：路径不存在时直接给修法，而不是启动一个必崩的进程。
  if (py !== 'python' && !fs.existsSync(py)) {
    console.log('找不到 OCR 用的 Python：' + py);
    console.log('  打开 http://127.0.0.1:7788/settings.html ，在「路径与端口」里填 manga-image-translator 的目录。');
    return false;
  }

  banner('manga-panel-studio');
  console.log('[mps] OCR 服务启动中');
  console.log('[mps]   解释器: ' + py);
  console.log('[mps]   服务脚本: ' + script);
  console.log('[mps]   OCR 依赖: manga-image-translator（' + (mtRoot() || '未配置，去设置页填') + '）');
  const today = new Date();
  const ymd = today.getFullYear() + String(today.getMonth()+1).padStart(2,'0') + String(today.getDate()).padStart(2,'0');
  const ocrLog = path.join(dataHome(), 'logs', 'ocr-service-' + ymd + '.log');
  console.log('[mps]   OCR 日志文件: ' + ocrLog + '（每天一个新文件，保留 14 天）');
  console.log('');
  console.log('[mps] 下面是 OCR 子进程的原始输出（前缀 [ocr]），它的日志会实时显示在这里：');
  console.log('');
  let child = null;
  try {
    child = spawn(py, [script, '--port', '5009', '--use-gpu'], {
      cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    child.unref();
  } catch (e) {
    console.log('启动失败：' + e.message);
    return false;
  }

  // 子进程输出不再转给终端：python 自己的 StreamHandler 已打印（带时间戳），
  // 这里再打就重复了。stderr（堆栈等）仍然转发。
  child.stderr && child.stderr.on('data', (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (line.trim()) process.stdout.write('[ocr-err] ' + line + '\n');
    }
  });

  console.log('  等待 5009 就绪（首次加载模型可能要 1 分钟）…');
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const h = await get('http://127.0.0.1:5009/health');
    if (h.ok) {
      console.log('');
      banner('manga-panel-studio');
      console.log('[mps] OCR 服务已就绪: http://127.0.0.1:5009/health');
      console.log('[mps] 服务在后台常驻运行（关掉这个终端也不影响）。');
      const alive = await get('http://127.0.0.1:7788/api/sessions');
      if (alive.ok) {
        console.log('[mps] 画布地址: http://127.0.0.1:7788');
      } else {
        console.log('[mps] 画布（7788）还没起，另开一个终端跑 manga-panel-studio');
      }
      return true;
    }
    if (child && child.exitCode !== null && child.exitCode !== 0) {
      console.log('');
      banner('manga-panel-studio');
      console.log('[mps] OCR 启动失败（exit ' + child.exitCode + '）');
      console.log('[mps] 失败原因见上面 [ocr] 行，完整日志: ' + ocrLog);
      return false;
    }
  }
  banner('manga-panel-studio');
  console.log('[mps] 90 秒还没就绪，可能还在加载模型，也可能已经失败。');
  console.log('[mps] 上面 [ocr] 行就是当时的输出。');
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 启动时把地址、数据目录、下一步说清楚，省得用户问「然后呢」。
function printStartInfo() {
  banner('manga-panel-studio');
  console.log('画布地址: http://127.0.0.1:7788');
  const home = dataHome();
  console.log('数据目录: ' + home);
  console.log('会话目录: ' + path.join(home, 'sessions'));
  console.log('');
  console.log('用起来分三步:');
  console.log('  1. 浏览器打开 http://127.0.0.1:7788/settings.html 填 API Key');
  console.log('  2. 把漫画图片放进会话目录，或用画布里的「导入图片」');
  console.log('  3. 另开一个终端跑 manga-panel-studio ocr 启动识别服务（5009）');
  console.log('');
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(1500);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
    s.connect(port, '127.0.0.1');
  });
}


function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (r) => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ ok: true, body: b }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ ok: false }); });
  });
}

if (cmd === 'start') {
  printStartInfo();
  const child = spawn(process.execPath, [path.join(ROOT_DIR, 'server', 'canvas.mjs')], {
    cwd: ROOT_DIR, stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else if (cmd === 'check') {
  (async () => {
    const canvas = await get('http://127.0.0.1:7788/api/sessions');
    console.log((canvas.ok ? 'OK ' : 'DOWN ') + 'canvas 7788');
    const ocr = await get('http://127.0.0.1:5009/health');
    console.log((ocr.ok ? 'OK ' : 'DOWN ') + 'ocr 5009');
    if (!canvas.ok) {
      console.log('\ncanvas 没在运行。启动：manga-panel-studio');
    }
  })();
} else {
  if (cmd === 'ocr') {
    startOcr().then((ok) => process.exit(ok ? 0 : 1));
  } else if (cmd === 'start-all') {
    (async () => {
      await startOcr();
      printStartInfo();
      const canvas = spawn(process.execPath, [path.join(ROOT_DIR, 'server', 'canvas.mjs')], { cwd: ROOT_DIR, stdio: 'inherit' });
      canvas.on('exit', (code) => process.exit(code ?? 0));
    })();
  } else {
  console.log('manga-panel-studio <command>\n\n  start      启动画布服务（默认，前台）\n  check      检查两个服务状态\n  ocr        启动 OCR 服务（5009，输出直接打到终端）\n  start-all  同时启动画布 + OCR');
  }
}
