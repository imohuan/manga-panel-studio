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

function spawnDetached(bin, args, cwd) {
  const child = spawn(bin, args, { cwd, stdio: 'ignore', detached: true });
  child.unref();
  return child.pid;
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
    const py = resolvePython();
    console.log('OCR 服务启动中（' + py + ' server/ocr_service.py --port 5009）');
    console.log('  首次启动要加载模型，/health 可能 20-40 秒后才通。');
    const pid = spawnDetached(py, [path.join(ROOT_DIR, 'server', 'ocr_service.py'), '--port', '5009', '--use-gpu'], ROOT_DIR);
    console.log('  已后台启动，pid=' + pid + '。探活：manga-panel-studio check');
  } else if (cmd === 'start-all') {
    console.log('启动画布（7788）+ OCR（5009）…');
    const py = resolvePython();
    spawnDetached(py, [path.join(ROOT_DIR, 'server', 'ocr_service.py'), '--port', '5009', '--use-gpu'], ROOT_DIR);
    const canvas = spawn(process.execPath, [path.join(ROOT_DIR, 'server', 'canvas.mjs')], { cwd: ROOT_DIR, stdio: 'inherit' });
    canvas.on('exit', (code) => process.exit(code ?? 0));
  } else {
  console.log('manga-panel-studio <command>\n\n  start   启动画布服务（默认）\n  check   检查服务状态');
  }
}
