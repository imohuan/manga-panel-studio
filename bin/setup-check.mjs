// npm install 后的检查脚本：只打印缺什么、去哪装，绝不静默下载。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const lines = [];

lines.push('manga-panel-studio 安装完成。安装后的检查：');

const settingsExample = fs.existsSync(path.join(root, 'settings.example.json'));
const hasSettings = fs.existsSync(path.join(root, 'settings.json'));
lines.push('  settings.json: ' + (hasSettings ? '已存在' : '未创建 —— 从 settings.example.json 复制一份再填 key，或在设置页里填'));
if (!hasSettings && settingsExample) {
  try { fs.copyFileSync(path.join(root, 'settings.example.json'), path.join(root, 'settings.json')); lines.push('  （已自动复制 example -> settings.json，key 留空等你填）'); } catch {}
}

const localData = path.join(os.tmpdir(), '..');
lines.push('  会话数据默认保存: %LOCALAPPDATA%/manga-panel-studio/sessions（可在设置页改）');
lines.push('  OCR 服务依赖 manga-image-translator：未装则在设置页填 translator.projectRoot 或设 MT_ROOT');
lines.push('  启动: manga-panel-studio   或   npm start');

console.log(lines.join('\n'));
