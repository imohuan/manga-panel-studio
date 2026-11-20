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

const LOG_DIR = path.join(process.env.STUDIO_DATA_DIR || path.join(os.homedir(), '.manga-panel-studio'), 'logs');

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

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, 'ocr.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  console.log('OCR 服务启动中（' + py + '）');
  console.log('  日志：' + logFile);
  const args = [script, '--port', '5009', '--use-gpu'];
  const child = spawn(py, args, {
    cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  child.unref();

  // 同一份输出同时写日志文件和当前终端：终端能立刻看到成败，文件留底可查。
  let sawOutput = false;
  const tee = (chunk, stream) => {
    sawOutput = true;
    logStream.write(chunk);
    stream.write(chunk);
  };
  child.stdout.on('data', (c) => tee(c, process.stdout));
  child.stderr.on('data', (c) => tee(c, process.stderr));
  child.on('error', (e) => {
    console.log('启动 OCR 进程失败：' + e.message);
    logStream.write('spawn error: ' + e.message + '\n');
  });

  // 4) 等 health 就绪（最多 60 秒，模型加载慢）；失败就读日志尾部给出真相。
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    if (child.exitCode !== null) {
      console.log('OCR 进程已退出（exit code ' + child.exitCode + '），日志最后几行：');
      printTail(logFile, 12);
      return false;
    }
    const h = await get('http://127.0.0.1:5009/health');
    if (h.ok) {
      console.log('OCR 服务已就绪：http://127.0.0.1:5009/health');
      console.log('  首次识别会加载模型，前几页会慢一些。');
      if (!sawOutput) console.log('  （本次没有新日志，服务可能已在别处启动）');
      return true;
    }
  }
  console.log('等了 60 秒还没就绪，可能还在加载模型。日志：' + logFile);
  printTail(logFile, 8);
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function printTail(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
    for (const l of lines.slice(-n)) console.log('  | ' + l.slice(0, 200));
  } catch {}
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
  console.log('manga-panel-studio starting...');
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
    console.log('启动画布（7788）+ OCR（5009）…');
    (async () => {
      await startOcr();
      const canvas = spawn(process.execPath, [path.join(ROOT_DIR, 'server', 'canvas.mjs')], { cwd: ROOT_DIR, stdio: 'inherit' });
      canvas.on('exit', (code) => process.exit(code ?? 0));
    })();
  } else {
  console.log('manga-panel-studio <command>\n\n  start      启动画布服务（默认，前台）\n  check      检查两个服务状态\n  ocr        启动 OCR 服务（5009，失败会说明原因）\n  start-all  同时启动画布 + OCR');
  }
}
