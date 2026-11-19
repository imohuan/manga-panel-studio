#!/usr/bin/env node
// manga-panel-studio 命令行入口
//   manga-panel-studio          启动画布服务（7788）
//   manga-panel-studio check    检查配置与服务
//   manga-panel-studio help     帮助
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cmd = process.argv[2] || 'start';

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
  console.log('manga-panel-studio <command>\n\n  start   启动画布服务（默认）\n  check   检查服务状态');
}
