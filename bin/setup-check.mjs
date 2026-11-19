// npm install 后的检查脚本：只打印缺什么、去哪装，绝不静默下载。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lines = [];

lines.push('manga-panel-studio 安装完成。安装后的检查：');

const dataHome = path.join(os.homedir(), '.manga-panel-studio');
if (!fs.existsSync(dataHome)) fs.mkdirSync(dataHome, { recursive: true });
const settingsFile = path.join(dataHome, 'settings.json');
const hasSettings = fs.existsSync(settingsFile);
const settingsExample = fs.existsSync(path.join(root, 'settings.example.json'));
lines.push('  settings.json: ' + settingsFile + (hasSettings ? '（已存在）' : '（未创建）'));
if (!hasSettings && settingsExample) {
  try { fs.copyFileSync(path.join(root, 'settings.example.json'), settingsFile); lines.push('    已自动复制 example -> ' + settingsFile + '（key 留空等你填）'); } catch {}
}
lines.push('  数据目录: ' + dataHome + '（sessions/ 与 settings.json 都在这里）');
lines.push('  OCR 服务依赖 manga-image-translator：未装则在设置页填 translator.projectRoot 或设 MT_ROOT');
lines.push('  启动: manga-panel-studio   或   npm start');

console.log(lines.join('\n'));
