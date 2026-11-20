/**
 * canvas.mjs — 漫画画布服务（主服务，Node，端口 7788）。
 *
 * 在整个流程中的位置：
 *   浏览器 (public/index.html + canvas.js)
 *     │  HTTP / SSE
 *     ▼
 *   本服务 ──> sessions/<会话>/ 存取画布数据（图片、框坐标、历史记录）
 *     │
 *     └──> ocr_service.py (5009)：整页/区域/框内的找框与识别
 *     └──> draw_boxes.py：把框画到图上，生成历史记录的「输出图」
 *     └──> render_check.py：生成带参考线的检查图（public/render.html 预览）
 *
 * 职责：
 *   1. 静态托管 public/（前端无构建，直接读文件）
 *   2. 会话管理：创建/切换/上传图片（ffmpeg 压缩后落到 sessions/<会话>/）
 *   3. 框数据 CRUD：GET/PUT /api/page/:page/boxes，写入即 SSE 广播给所有浏览器
 *   4. 任务队列：整页找框/识别、区域找框/识别、框内识别 —— 逐图排队，
 *      每个任务调用 ocr_service.py 对应接口，把结果写回会话 JSON 并留历史
 *   5. 历史记录：每次 AI/手动操作都落 history/ops.json（引用 images/ 下去重图片）
 *   6. 备份：/api/session/:name/backup 拍快照到 sessions/<会话>/backup/
 *
 * 注意：本文件不包含任何 OCR 逻辑，模型调用全部在 ocr_service.py。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings, publicView, mergeIncoming,
         openaiListModels, checkOpenaiModel, doubaoTts, translatorPing,
         loadDoubaoAuth, readCharactersRaw, normalizeCharacters, updateCharacter,
         charVoicesView, readAudioScripts, callDoubao, safeToolName, findRefPath,
         cleanBaseUrl, maskKey, resolvePaths } from './tools_helpers.js';
import { handleToolRoutes } from './tool_routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');   // 项目根（仓库所在目录）
const PORT = 7788;                                 // 画布服务端口（画布地址 = settings.translator/canvas）
// 路径与端口统一从 settings.json 读，不再写死盘符。
// 优先级：环境变量 > settings.json > 内置默认。
// ROOT/OCR/FFMPEG 用 getter：设置页保存后无需重启即可生效（下次请求就用到新值）。
const settingsNow = () => loadSettings();
const ROOT = () => resolvePaths(settingsNow()).ROOT;   // sessions 目录
const OCR = () => process.env.STUDIO_OCR_BASE || resolvePaths(settingsNow()).ocrBaseUrl;
const FFMPEG = () => resolvePaths(settingsNow()).ffmpegPath || 'ffmpeg';
const PY = () => process.env.STUDIO_PYTHON || resolvePython(settingsNow());
// Python 解释器：从 settings.translator.projectRoot 推导（MT 目录里有 py310/venv 就用），
// 找不到再回退 PATH 里的 python。
function resolvePython(settings) {
  const mtRoot = process.env.MT_ROOT || (settings.translator && settings.translator.projectRoot) || '';
  const cands = mtRoot ? [
    path.join(mtRoot, 'py310', 'python.exe'),
    path.join(mtRoot, 'venv', 'Scripts', 'python.exe'),
    path.join(mtRoot, '.venv', 'Scripts', 'python.exe'),
  ] : [];
  for (const c of cands) { try { fs.accessSync(c); return c; } catch {} }
  return 'python';
}
// ---- 设置界面 + 音频管理（合并自 tools/settings 与 tools/audio 独立服务）----
// helpers 见 tools_helpers.js
fs.mkdirSync(ROOT(), { recursive: true });

// ---------- 工具 ----------
const jpegSize = (buf) => {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return { width: 0, height: 0 };
};

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); };

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const body = (req) => new Promise((r) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { try { r(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { r({}); } });
});

// ---------- 会话（一个文件夹 = 一个画布）----------
const sessionDir = (name) => path.join(ROOT(), name);
const sessions = () => fs.readdirSync(ROOT()).filter((n) => fs.statSync(path.join(ROOT(), n)).isDirectory());

function listPages(session) {
  const dir = sessionDir(session);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && !f.startsWith('.'))
    .sort()
    .map((f) => {
      const base = path.basename(f, path.extname(f));
      const metaFile = path.join(dir, `${base}.json`);
      const meta = readJson(metaFile, { regions: [] });
      const buf = fs.readFileSync(path.join(dir, f));
      return {
        page: base, file: f, image: `/s/${encodeURIComponent(session)}/img/${encodeURIComponent(f)}`,
        ...(f.endsWith('.png') ? pngSize(buf) : jpegSize(buf)),
        regions: meta.regions || [],
        status: meta.status || 'idle',
        sha: meta.sha || '',
      };
    });
}

function pngSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}

// ---------- 历史记录 ----------
// 结构：<session>/history/ops.json  一个文件存全部操作
//       <session>/history/images/*.jpg  所有图片（压缩后），按内容哈希命名去重
const HISTORY_DIR = (session) => path.join(sessionDir(session), 'history');
const IMAGES_DIR = (session) => path.join(HISTORY_DIR(session), 'images');
const AUDIO_DIR = (session) => path.join(HISTORY_DIR(session), 'audio');
const OPS_FILE = (session) => path.join(HISTORY_DIR(session), 'ops.json');

function readOps(session) {
  return readJson(OPS_FILE(session), { version: 1, ops: [] });
}

function appendOp(session, op) {
  const db = readOps(session);
  const rec = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ts: new Date().toISOString(), ...op };
  db.ops.push(rec);
  writeJson(OPS_FILE(session), db);
  broadcast('op', { session, op: rec });
  return rec;
}

// 判断图片真实格式（历史里的图曾经出现「PNG 内容配 .jpg 名字」的情况）
const imageExt = (buf) => {
  if (buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.length > 11 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return '.jpg';
};

// 图片落盘：压缩成真正的 JPEG + 内容哈希去重
// 压缩失败时用 PIL 兜底（ffmpeg 的参数一旦写错会静默失败，别把原图当压缩图存进去）
function saveImage(session, buf, tag = 'img') {
  const dir = IMAGES_DIR(session);
  fs.mkdirSync(dir, { recursive: true });
  const h = sha1(buf);
  const name = `${tag}-${h}.jpg`;
  const target = path.join(dir, name);
  if (fs.existsSync(target)) {
    // 同名文件可能是历史遗留的「PNG 内容配 .jpg 名字」，浏览器会显示成裂图。
    // 只有真实 JPEG 才能直接复用，否则删掉重新压。
    try {
      const head = Buffer.alloc(3);
      const fd = fs.openSync(target, 'r');
      fs.readSync(fd, head, 0, 3, 0);
      fs.closeSync(fd);
      if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return name;
    } catch {}
    fs.rmSync(target, { force: true });
  }

  const tmp = path.join(dir, `_tmp-${h}.img`);
  const out = path.join(dir, `_out-${h}.jpg`);
  fs.writeFileSync(tmp, buf);
  let done = false;
  try {
  execFileSync(FFMPEG(), ['-y', '-loglevel', 'error', '-i', tmp,
      '-vf', "scale='min(1400,iw)':-2", '-q:v', '4', out], { stdio: 'ignore' });
    done = fs.existsSync(out) && fs.statSync(out).size > 0;
  } catch { done = false; }
  if (!done) {
    // 兜底：用项目自带的 Python/PIL 压一次
    try {
  execFileSync(PY(), [path.join(__dirname, 'compress_image.py'), tmp, out], { stdio: 'ignore' });
      done = fs.existsSync(out) && fs.statSync(out).size > 0;
    } catch { done = false; }
  }
  fs.rmSync(tmp, { force: true });
  if (done) {
    fs.renameSync(out, target);
  } else {
    // 实在压不了就原样存，但按真实格式命名，避免浏览器按错类型解码
    fs.rmSync(out, { force: true });
    const ext = imageExt(buf);
    if (ext === '.jpg') { fs.writeFileSync(target, buf); return name; }
    const alt = path.join(dir, `${tag}-${h}${ext}`);
    fs.writeFileSync(alt, buf);
    return path.basename(alt);
  }
  return name;
}

// 音频落盘：历史里的音频按内容哈希去重，避免重新生成后旧记录被覆盖。
function saveAudio(session, buf, tag = 'audio', ext = '.mp3') {
  const dir = AUDIO_DIR(session);
  fs.mkdirSync(dir, { recursive: true });
  const h = sha1(buf);
  const name = `${tag}-${h}${ext}`;
  const target = path.join(dir, name);
  if (!fs.existsSync(target)) fs.writeFileSync(target, buf);
  return name;
}

// 删除一条记录后，清理它独占的图片（仍被其他记录引用的保留）
function pruneImages(session, removed) {
  const db = readOps(session);
  const used = new Set();
  for (const o of db.ops) {
    if (o.input?.image) used.add(o.input.image);
    if (o.output?.image) used.add(o.output.image);
    if (o.data?.modelInput) used.add(o.data.modelInput);
    if (o.audio?.file) used.add(o.audio.file);
    if (o.data?.refAudio?.file) used.add(o.data.refAudio.file);
    for (const t of o.data?.trace || []) if (t.image) used.add(t.image);
  }
  const candidates = [removed?.input?.image, removed?.output?.image, removed?.data?.modelInput,
    ...(removed?.data?.trace || []).map((t) => t.image)].filter(Boolean);
  for (const name of candidates) {
    if (used.has(name)) continue;
    const f = path.join(IMAGES_DIR(session), path.basename(name));
    try { fs.rmSync(f, { force: true }); } catch {}
  }

  // 音频在 history/audio 下，单独按引用清理
  const audioCandidates = [removed?.audio?.file, removed?.data?.refAudio?.file].filter(Boolean);
  for (const name of audioCandidates) {
    if (used.has(name)) continue;
    try { fs.rmSync(path.join(AUDIO_DIR(session), path.basename(name)), { force: true }); } catch {}
  }
}

// 中间图落盘：Python 每一步回传的 base64 直接存成图片，历史卡片里展示
function saveTrace(session, trace, prefix = '') {
  const out = [];
  if (!trace || typeof trace !== 'object') return out;
  for (const [key, v] of Object.entries(trace)) {
    if (key === 'counts' || !v || !v.image) continue;
    try {
      const name = saveImage(session, Buffer.from(v.image, 'base64'), `tr-${key}`);
      out.push({ key, label: prefix + (v.label || key), image: name });
    } catch {}
  }
  return out;
}

// ---------- SSE ----------
const clients = new Set();
function broadcast(ev, data) {
  const s = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(s);
}

// ---------- 任务队列（串行）----------
// 两个接口 × 两种范围，一共四种基本模式：
//   detect-page / ocr-page      整页找框 / 整页识别
//   detect-region / ocr-region  只处理画出来的那一块（后台真的裁图再送模型）
    //   ocr-boxes                   只识别已有框（逐框走 /ocr/box，模型只看框内文字条）
const queue = [];
let running = null;
const jobs = new Map();

const MODES = ['detect-page', 'ocr-page', 'detect-region', 'ocr-region', 'ocr-boxes'];
const MODE_ALIAS = { detect: 'detect-page', ocr: 'ocr-page', boxes: 'ocr-boxes' };

function normalizeMode(mode) {
  const m = MODE_ALIAS[mode] || mode;
  return MODES.includes(m) ? m : 'ocr-page';
}

function enqueue(session, page, rawMode, opts = {}) {
  const mode = normalizeMode(rawMode);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const box = opts.box ? opts.box.map(Number) : null;
  const boxes = opts.boxes ? opts.boxes.map((b) => b.map(Number)) : (box ? [box] : null);
  const job = { id, session, page, mode, box, boxes, status: 'queued', ts: new Date().toISOString() };
  jobs.set(id, job);
  queue.push(job);
  broadcast('job', job);
  pump();
  return job;
}

// 暂停：只对还没开始的任务有效（运行中的任务做完就停）
function pauseJob(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: '任务不存在' };
  if (job.status === 'running') return { ok: false, error: '任务正在运行，无法暂停' };
  if (job.status !== 'queued') return { ok: false, error: `任务状态是 ${job.status}` };
  const i = queue.findIndex((j) => j.id === id);
  if (i < 0) return { ok: false, error: '任务不在队列里' };
  queue.splice(i, 1);
  job.status = 'paused';
  job.pausedAt = Date.now();
  broadcast('job', job);
  return { ok: true, job };
}

function resumeJob(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: '任务不存在' };
  if (job.status !== 'paused') return { ok: false, error: `任务状态是 ${job.status}` };
  job.status = 'queued';
  delete job.pausedAt;
  queue.unshift(job);                 // 恢复后放到队首，尽快执行
  broadcast('job', job);
  pump();
  return { ok: true, job };
}

function removeJob(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: '任务不存在' };
  if (job.status === 'running') return { ok: false, error: '任务正在运行，无法删除' };
  const i = queue.findIndex((j) => j.id === id);
  if (i >= 0) queue.splice(i, 1);
  jobs.delete(id);
  broadcast('job-removed', { id });
  return { ok: true };
}

async function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  running = job;
  job.status = 'running';
  job.startedAt = Date.now();
  broadcast('job', job);
  try {
    const dir = sessionDir(job.session);
    const pages = listPages(job.session);
    const p = pages.find((x) => x.page === job.page);
    if (!p) throw new Error('找不到这张图');
    const file = path.join(dir, p.file);
    const buf = fs.readFileSync(file);
    const b64 = buf.toString('base64');

    const metaFile = path.join(dir, `${job.page}.json`);
    const meta = readJson(metaFile, { page: job.page, regions: [] });

    const isRegion = job.mode.endsWith('-region');
    const isDetect = job.mode.startsWith('detect');
    if (isRegion && !job.box) throw new Error('区域任务缺少框');
    if (job.mode === 'ocr-boxes' && !(job.boxes || []).length) throw new Error('没有可识别的框');

    // 两个接口 × 两种范围
    let endpoint;
    let payload;
    if (job.mode === 'detect-page') {
      endpoint = 'detect'; payload = { image: b64 };
    } else if (job.mode === 'ocr-page') {
      endpoint = 'ocr'; payload = { image: b64 };
    } else if (job.mode === 'detect-region') {
      endpoint = 'detect/region'; payload = { image: b64, box: job.box };
    } else if (job.mode === 'ocr-region') {
      endpoint = 'ocr/region'; payload = { image: b64, box: job.box };
    } else {
      endpoint = 'ocr/box'; payload = { image: b64, box: null };   // 下面逐框请求
    }

    // 按框识别：逐个框请求 /ocr/box，模型每次只看这个框里的文字条
    let data;
    if (job.mode === 'ocr-boxes') {
      const items = [];
      let totalMs = 0;
      for (const b of job.boxes) {
        const rr = await fetch(`${OCR()}/ocr/box`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: b64, box: b }),
        });
        if (!rr.ok) throw new Error(`OCR ${rr.status}`);
        const one = await rr.json();
        totalMs += one.ms || 0;
        items.push({ box: b, one });
      }
      data = {
        width: items[0]?.one?.width, height: items[0]?.one?.height, ms: totalMs,
        count: items.filter((x) => (x.one.regions?.[0]?.text || '').trim()).length,
        items,
      };
    } else {
    const r = await fetch(`${OCR()}/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`OCR ${r.status}`);
      data = await r.json();
    }

    const inBox = (r) => {
      const c = [(r.box[0] + r.box[2]) / 2, (r.box[1] + r.box[3]) / 2];
      const b = job.box;
      return c[0] >= b[0] && c[0] <= b[2] && c[1] >= b[1] && c[1] <= b[3];
    };
    const hitRate = (a, b) => {
      const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
      const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
      return (iw * ih) / Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
    };

    meta.page = job.page;
    if (data.width) meta.width = data.width;
    if (data.height) meta.height = data.height;
    const old = meta.regions || [];

    // 防清空：整页识别/找框返回 0 个框时，绝不覆盖原有数据
    // （检测偶尔会漏掉整页，之前这样把 7 页的框全清空过）
    const incoming = Array.isArray(data.regions) ? data.regions : [];
    if ((job.mode === 'detect-page' || job.mode === 'ocr-page')
        && incoming.length === 0 && old.length > 0) {
      throw new Error(`${job.mode} 返回 0 个框，已保留原有 ${old.length} 个，未覆盖`);
    }

    if (job.mode === 'detect-page') {
      meta.regions = incoming;
    } else if (job.mode === 'ocr-page') {
      meta.regions = incoming;
    } else if (job.mode === 'detect-region') {
      // 区域找框：把落在这一块里的旧框换成这次的结果，别处保持不动
      const found = Array.isArray(data.regions) ? data.regions : [];
      const kept = old.filter((x) => !inBox(x));
      const inRegion = old.filter((x) => inBox(x));
      // 防清空：这块本来有框，却识别出 0 个 —— 保留旧框，别删
      if (found.length === 0 && inRegion.length > 0) {
        meta.regions = old;
        job.warning = `这块原有 ${inRegion.length} 个框，本次识别到 0 个，已保留原框`;
      } else {
        meta.regions = kept.concat(found.map((x) => ({ ...x, source: 'region' })));
      }
    } else if (job.mode === 'ocr-region') {
      // 区域识别：只回填这一块里已有框的文字
      const found = data.regions || [];
      meta.regions = old.map((x) => {
        if (!inBox(x)) return x;
        const best = found
          .map((f) => ({ f, s: hitRate(x.box, f.box) }))
          .sort((a, b) => b.s - a.s)[0];
        return best && best.s > 0.3 && best.f.text
          ? { ...x, text: best.f.text, prob: best.f.prob, source: 'region-ocr' }
          : x;
      });
    } else {
      // 只识别已有框：每个框单独走 /ocr/box，文字直接来自那个框里的文字条
      const byKey = new Map();
      for (const it of data.items || []) {
        const r0 = it.one.regions?.[0];
        byKey.set(it.box.map((v) => Math.round(Number(v))).join(','), r0 || null);
      }
      meta.regions = old.map((x) => {
        const hit = byKey.get(x.box.map((v) => Math.round(Number(v))).join(','));
        return hit && (hit.text || '').trim()
          ? { ...x, text: hit.text, prob: hit.prob, source: 'ocr-box' }
          : x;
      });
    }
    meta.status = 'done';
    meta.sha = sha1(buf);
    writeJson(metaFile, meta);

    // 历史里的「输入图」必须真的是送给模型的那张：
    // 整页模式是整张原图，区域模式是后台裁出来的那一块。
    // 历史里的「输入图」：
    //   整页 → 整张原图    区域 → 裁剪块    框内 → 框所在的原始裁剪图（未做任何变形）
    let inputBuf = buf;
    let drawBoxes = (data.regions || []).map((x) => x.box);
    let inTag = 'in';
    let modelInputName = null;
    if (job.mode === 'ocr-boxes') {
      const first = (data.items || [])[0]?.one;
      if (first?.input) {
        inputBuf = Buffer.from(first.input, 'base64');
        // 输出图就在这张裁剪图上标出识别到的行
        drawBoxes = (first.regions?.[0]?.linesInCrop) || [];
        inTag = 'box';
      }
      // 模型真正吃到的长条图另存一份，作为附加信息
      const mi = (data.items || []).map((it) => it.one.modelInput).find(Boolean);
      if (mi) modelInputName = saveImage(job.session, Buffer.from(mi, 'base64'), 'strip');
    } else if (isRegion && data.input) {
      inputBuf = Buffer.from(data.input, 'base64');
      drawBoxes = (data.regions || []).map((x) => x.cropBox || x.box);
      inTag = 'crop';
    }
    const inName = saveImage(job.session, inputBuf, inTag);

    let outName = null;
    try {
      outName = await renderBoxes(job, inputBuf, drawBoxes);
    } catch {}

    // 中间图：整页/区域任务保存 Python 每一步的可视化；框内识别逐框保存
    let trace = [];
    if (job.mode === 'ocr-boxes') {
      // 逐框识别时中间图会翻倍增长，只保留前几个框的步骤图，够看就够了
      (data.items || []).slice(0, 8).forEach((it, i) => {
        const b = it.box.map((v) => Math.round(Number(v))).join(',');
        trace = trace.concat(saveTrace(job.session, it.one?.trace, `框${i + 1} ${b} · `));
      });
    } else {
      trace = saveTrace(job.session, data.trace);
    }

    const scope = isRegion
      ? `区域 ${job.box.map((v) => Math.round(v)).join(',')}`
      : '';
    const summary = {
      'detect-page': `整页找框：${data.count} 个 / ${data.ms}ms`,
      'detect-region': `${scope} 找框：${data.count} 个 / ${data.ms}ms`,
      'ocr-page': `整页识别：${data.count} 个 / ${data.ms}ms`,
      'ocr-region': `${scope} 识别：${data.count} 个 / ${data.ms}ms`,
      'ocr-boxes': `框内识别：${data.count} 个框 / ${data.ms}ms`,
    }[job.mode];

    const opScope = job.mode === 'ocr-boxes' ? 'box' : isRegion ? 'region' : 'page';

    const op = appendOp(job.session, {
      kind: isDetect ? 'detect' : 'ocr',
      mode: job.mode,
      by: job.by || 'ui',
      page: job.page,
      jobId: job.id,
      ms: data.ms,
      summary,
      region: isRegion ? job.box : null,
      input: { image: inName, box: isRegion ? job.box : null, scope: opScope },
      output: { image: outName, count: data.count },
      data: {
        size: isRegion && data.region ? data.region.cropSize : [data.width, data.height],
        scope: opScope,
        region: data.region || null,
        fallback: data.fallback ?? null,
        modelInput: modelInputName,
        trace,
        boxes: job.mode === 'ocr-boxes' ? (data.items || []).map((it) => ({
          box: it.box,
          lines: it.one.regions?.[0]?.lines ?? null,
          stripSize: it.one.regions?.[0]?.stripSize ?? null,
          text: it.one.regions?.[0]?.text ?? '',
          cropSize: it.one.regions?.[0]?.cropSize ?? null,
          strategy: it.one.regions?.[0]?.strategy ?? null,
        })) : null,
        regions: data.regions || [],
        // 当时的完整框数据：历史卡片可以用它一键还原到这一步（不用再存一份原图）。
        snapshot: meta.regions,
      },
    });

    job.status = 'done';
    job.result = { count: data.count, ms: data.ms, opId: op.id, fallback: data.fallback ?? null };
    job.finishedAt = Date.now();
    broadcast('job', job);
    broadcast('pages', { session: job.session });
  } catch (e) {
    job.status = 'error';
    job.error = String(e.message || e);
    job.finishedAt = Date.now();
    broadcast('job', job);
  } finally {
    running = null;
    setTimeout(pump, 30);
  }
}

async function renderBoxes(job, srcBuf, boxes) {
  const out = path.join(IMAGES_DIR(job.session), `_draw-${job.id}.png`);
  const src = path.join(IMAGES_DIR(job.session), `_src-${job.id}.img`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(src, srcBuf);
const script = path.join(__dirname, 'draw_boxes.py');
  const args = [script, src, out, JSON.stringify(boxes || [])];
  try {
  await new Promise((res, rej) => execFile(PY(), args, (e) => (e ? rej(e) : res())));
  } finally {
    fs.rmSync(src, { force: true });
  }
  const buf = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  return saveImage(job.session, buf, 'out');
}

// ---------- HTTP ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ sessions: sessions(), jobs: [...jobs.values()].slice(-50) })}\n\n`);
      clients.add(res);
      const t = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(t); clients.delete(res); });
      return;
    }

    if (p === '/api/sessions' && req.method === 'POST') {
      const d = await body(req);
      const name = String(d.name || '').trim().replace(/[\\/:*?"<>|]/g, '_');
      if (!name) return send(res, 400, { error: '名字不能为空' });
      fs.mkdirSync(sessionDir(name), { recursive: true });
      return send(res, 200, { ok: true, name });
    }
    if (p === '/api/sessions') return send(res, 200, { sessions: sessions() });

    let m = p.match(/^\/api\/session\/([^/]+)$/);
    if (m) return send(res, 200, { session: m[1], pages: listPages(m[1]) });

    m = p.match(/^\/api\/session\/([^/]+)\/upload$/);
    if (m && req.method === 'POST') {
      const d = await body(req);
      const dir = sessionDir(m[1]);
      fs.mkdirSync(dir, { recursive: true });
      const saved = [];
      for (const f of d.files || []) {
        const buf = Buffer.from(String(f.data).split(',').pop(), 'base64');
        const ext = (f.name.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0].toLowerCase();
        let base = path.basename(f.name, path.extname(f.name));
        let target = path.join(dir, base + ext);
        let n = 1;
        while (fs.existsSync(target)) target = path.join(dir, `${base}_${n++}${ext}`);
        fs.writeFileSync(target, buf);
        saved.push(path.basename(target));
      }
      broadcast('pages', { session: m[1] });
      return send(res, 200, { ok: true, saved });
    }

    m = p.match(/^\/api\/session\/([^/]+)\/page\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const page = listPages(m[1]).find((x) => x.page === m[2]);
      if (!page) return send(res, 404, { error: 'no page' });
      return send(res, 200, page);
    }

    // 备份：把一页的框另存一份，覆盖事故时能还原
    const bm = p.match(/^\/api\/session\/([^/]+)\/backup$/);
    if (bm && req.method === 'POST') {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = path.join(sessionDir(bm[1]), 'backup', ts);
      fs.mkdirSync(dir, { recursive: true });
      let n = 0;
      for (const pg of listPages(bm[1])) {
        writeJson(path.join(dir, `${pg.page}.json`),
          { page: pg.page, width: pg.width, height: pg.height, regions: pg.regions });
        n += pg.regions.length;
      }
      return send(res, 200, { ok: true, dir: path.basename(dir), boxes: n });
    }
    if (m && req.method === 'PUT') {
      const d = await body(req);
      const metaFile = path.join(sessionDir(m[1]), `${m[2]}.json`);
      const meta = readJson(metaFile, { page: m[2] });
      const incoming = Array.isArray(d.regions) ? d.regions : null;
      const cur = meta.regions || [];

      // 防覆盖：客户端带的 sha 与磁盘上的不一致，说明这页已经被别人改过
      if (d.sha && meta.sha && d.sha !== meta.sha) {
        return send(res, 409, { error: '这页已被更新，请刷新后再改' });
      }
      // 防误清空：把有框的页写成 0 个框，必须是明确的清空操作
      if (incoming && incoming.length === 0 && cur.length > 0
          && d.op !== 'box-clear' && d.op !== 'box-erase' && !d.force) {
        return send(res, 409, { error: `这页原有 ${cur.length} 个框，拒绝写成空（请用「清空」按钮）` });
      }
      meta.regions = incoming || cur;
      writeJson(metaFile, meta);
      // 手动操作也记一条，方便回溯
      if (d.op) {
        const box = d.box ? d.box.map((v) => Math.round(v)) : null;
        const rec = appendOp(m[1], {
          kind: d.op, by: d.by || 'ui', page: m[2],
          summary: d.summary || ({
            'box-add': '新建框', 'box-del': '删除框', 'box-edit': '修改文字',
            'box-clear': '清空本页框', 'box-erase': '橡皮擦删框',
          }[d.op] || d.op),
          input: { image: null, box },
          output: { image: null, count: meta.regions.length },
          data: { before: d.before ?? null, after: d.after ?? null, box,
                  count: meta.regions.length, boxes: d.boxes ?? null },
        });
        broadcast('pages', { session: m[1] });
        return send(res, 200, { ok: true, count: meta.regions.length, opId: rec.id });
      }
      broadcast('pages', { session: m[1] });
      return send(res, 200, { ok: true, count: meta.regions.length });
    }

    m = p.match(/^\/api\/session\/([^/]+)\/job$/);
    if (m && req.method === 'POST') {
      const d = await body(req);
      const job = enqueue(m[1], d.page, d.mode, { box: d.box || null, boxes: d.boxes || null });
      return send(res, 200, job);
    }

    m = p.match(/^\/api\/session\/([^/]+)\/jobs$/);
    if (m && req.method === 'POST') {           // 批量
      const d = await body(req);
      const out = (d.pages || []).map((pg) => enqueue(m[1], pg, d.mode || 'ocr-page'));
      return send(res, 200, { queued: out.length, jobs: out });
    }

    // 跨页擦除：一次请求写多页，只记一条历史
    m = p.match(/^\/api\/session\/([^/]+)\/erase$/);
    if (m && req.method === 'POST') {
      const d = await body(req);
      const dir = sessionDir(m[1]);
      const list = Array.isArray(d.pages) ? d.pages : [];
      if (!list.length) return send(res, 400, { error: '没有要保存的页' });
      const shaMap = {};
      const applied = [];
      for (const it of list) {
        const metaFile = path.join(dir, `${it.page}.json`);
        const meta = readJson(metaFile, { page: it.page });
        if (it.sha && meta.sha && it.sha !== meta.sha) {
          return send(res, 409, { error: `${it.page} 已被更新，请刷新后再改` });
        }
        meta.regions = Array.isArray(it.regions) ? it.regions : (meta.regions || []);
        writeJson(metaFile, meta);
        applied.push({ page: it.page, boxes: it.boxes || [], left: meta.regions.length });
      }
      const op = appendOp(m[1], {
        kind: 'box-erase', by: 'ui', page: applied.length === 1 ? applied[0].page : null,
        summary: `橡皮擦删框：${d.total ?? '?'} 个 · ${applied.length} 页`,
        input: { image: null, box: null },
        output: { image: null, count: d.total ?? null },
        data: {
          scope: 'erase',
          count: d.total ?? null,
          pages: applied.map((a) => ({ page: a.page, boxes: a.boxes, left: a.left })),
        },
      });
      broadcast('pages', { session: m[1] });
      return send(res, 200, { ok: true, opId: op.id, pages: applied.map((a) => a.page) });
    }

    // 手动操作也要留痕：清空框、批量删、橡皮擦
    m = p.match(/^\/api\/session\/([^/]+)\/op$/);
    if (m && req.method === 'POST') {
      const d = await body(req);
      const op = appendOp(m[1], {
        kind: d.kind || 'box-del', by: d.by || 'ui', page: d.page || null,
        summary: d.summary || '手动操作',
        input: { image: null, box: d.box || null },
        output: { image: null, count: d.count ?? null },
        data: { boxes: d.boxes || null, count: d.count ?? null, before: d.before ?? null },
      });
      return send(res, 200, { ok: true, op });
    }

    // 历史还原：把某条记录当时的框数据写回这页
    m = p.match(/^\/api\/session\/([^/]+)\/history\/([^/]+)\/restore$/);
    if (m && req.method === 'POST') {
      const db = readOps(m[1]);
      const op = db.ops.find((o) => o.id === m[2]);
      if (!op) return send(res, 404, { error: '记录不存在' });
      const snap = op.data?.snapshot;
      const page = op.page;
      if (!Array.isArray(snap) || !page) return send(res, 400, { error: '这条记录没有可还原的框数据' });
      const metaFile = path.join(sessionDir(m[1]), `${page}.json`);
      const meta = readJson(metaFile, { page, regions: [] });
      meta.regions = snap;
      writeJson(metaFile, meta);
      // 还原记录本身也带快照（可以来回跳），但标题要剥掉重复的「还原到：」
      const base = String(op.summary || op.kind).replace(/^还原到：/, '').replace(/（\d+ 框）$/, '');
      const rec = appendOp(m[1], {
        kind: 'box-restore', by: 'ui', page,
        summary: `还原到：${base}（${snap.length} 框）`,
        input: { image: null, box: null },
        output: { image: null, count: snap.length },
        data: { count: snap.length, boxes: snap.map((r) => r.box), snapshot: snap, restoredFrom: op.id },
      });
      broadcast('pages', { session: m[1] });
      return send(res, 200, { ok: true, count: snap.length, opId: rec.id });
    }

    if (p === '/api/jobs') {
      const list = [...jobs.values()];
      return send(res, 200, {
        running: running?.id || null,
        queued: queue.length,
        counts: {
          queued: list.filter((j) => j.status === 'queued').length,
          running: list.filter((j) => j.status === 'running').length,
          paused: list.filter((j) => j.status === 'paused').length,
          done: list.filter((j) => j.status === 'done').length,
          error: list.filter((j) => j.status === 'error').length,
        },
        jobs: list.slice(-200),
      });
    }

    m = p.match(/^\/api\/jobs\/([^/]+)\/(pause|resume)$/);
    if (m && req.method === 'POST') {
      const r = m[2] === 'pause' ? pauseJob(m[1]) : resumeJob(m[1]);
      return send(res, r.ok ? 200 : 400, r);
    }

    m = p.match(/^\/api\/jobs\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      const r = removeJob(m[1]);
      return send(res, r.ok ? 200 : 400, r);
    }

    m = p.match(/^\/api\/session\/([^/]+)\/history$/);
    if (m && req.method === 'GET') {
      const db = readOps(m[1]);
      const base = `/s/${encodeURIComponent(m[1])}/hist-img`;
      const audioBase = `/s/${encodeURIComponent(m[1])}/hist-audio`;
      const pageInfo = new Map(listPages(m[1]).map((pg) => [pg.page, pg]));
      const ops = db.ops.slice().reverse().map((o) => ({
        ...o,
        inputUrl: o.input?.image ? `${base}/${o.input.image}` : null,
        outputUrl: o.output?.image ? `${base}/${o.output.image}` : null,
        audioUrl: o.audio?.file ? `${audioBase}/${o.audio.file}` : null,
        refAudioUrl: o.data?.refAudio?.file ? `${audioBase}/${o.data.refAudio.file}` : null,
        traceUrls: (o.data?.trace || []).map((t) => ({
          key: t.key, label: t.label, url: t.image ? `${base}/${t.image}` : null,
        })),
        // 手动改框不存图片：前端用这张页图 + 框坐标现场画
        pageUrl: pageInfo.has(o.page) ? `/s/${encodeURIComponent(m[1])}/img/${encodeURIComponent(pageInfo.get(o.page).file)}` : null,
        pageSize: pageInfo.has(o.page) ? [pageInfo.get(o.page).width, pageInfo.get(o.page).height] : null,
      }));
      return send(res, 200, { ops, total: db.ops.length });
    }

    // AI 读图校验（CLI view）：把预览图、原始提示词、模型参数和模型回答一起留进历史
    m = p.match(/^\/api\/session\/([^/]+)\/check$/);
    if (m && req.method === 'POST') {
      const d = await body(req);
      const page = String(d.page || '');
      if (!page) return send(res, 400, { error: '缺少 page' });
      let preview = null;
      if (d.previewB64) {
        try { preview = saveImage(m[1], Buffer.from(d.previewB64, 'base64'), 'view'); } catch {}
      }
      const pass = typeof d.pass === 'boolean' ? d.pass
        : String(d.answer || '').trim().toUpperCase().startsWith('PASS');
      const op = appendOp(m[1], {
        kind: 'ai-check', by: d.by || 'cli', page,
        ms: d.ms ?? null,
        summary: `AI 读图校验：${pass ? 'PASS' : '有问题'}${d.model ? ' · ' + d.model : ''}`,
        input: { image: preview, box: null, scope: 'view' },
        output: { image: null, count: d.regions ?? null },
        data: {
          scope: 'view',
          pass,
          answer: String(d.answer || ''),
          error: d.error || null,
          prompt: d.prompt || null,
          systemPrompt: d.systemPrompt || null,
          params: d.params || null,
          render: d.render || null,
          regions: Array.isArray(d.regionsData) ? d.regionsData : null,
        },
      });
      return send(res, 200, { ok: true, opId: op.id });
    }

    // 分镜 md：右侧面板「分镜」tab 用。只读，按页返回原文，
    // 流水线（CLI ocr / next）：把「排队了哪些页」「取走了哪页」写进历史，
    // 让 agent 的流水线节奏在画布上可追溯。不涉及图片。
    m = p.match(/^\/api\/session\/([^/]+)\/pipeline$/);
    if (m && req.method === 'POST') {
      const d = await body(req);
      const kind = String(d.kind || '');
      if (!['pipeline-ocr', 'pipeline-next'].includes(kind)) {
        return send(res, 400, { error: 'kind 只能是 pipeline-ocr / pipeline-next' });
      }
      const op = appendOp(m[1], {
        kind, by: d.by || 'cli', page: d.page || null,
        summary: kind === 'pipeline-ocr'
          ? 'OCR 排队 ' + (Array.isArray(d.pages) ? d.pages.length : 0) + ' 页（后台识别中）'
          : '流水线取页 -> ' + (d.page || '?') + '（转校验/写 md）',
        input: { image: null, box: null, scope: 'pipeline' },
        output: { image: null, count: Array.isArray(d.pages) ? d.pages.length : null },
        data: {
          scope: 'pipeline',
          pages: Array.isArray(d.pages) ? d.pages : (d.page ? [d.page] : []),
          remaining: d.remaining ?? null,
        },
      });
      return send(res, 200, { ok: true, opId: op.id });
    }

    // 静态审计（CLI check-audio / check-characters）：把检查结论留进历史，
    // 让「改完有没有检查、检查结果是什么」在画布上可追溯。
    m = p.match(/^\/api\/session\/([^/]+)\/audit$/);
    if (m && req.method === 'POST') {
      const d = await body(req);
      const scope = String(d.scope || 'audit');
      if (!['audio', 'characters'].includes(scope)) {
        return send(res, 400, { error: 'scope 只能是 audio / characters' });
      }
      // 历史里的 scope 用 audit-audio / audit-characters，
      // 不能复用 audio ——那会和「音频生成」记录撞名，前端会误渲染。
      const auditScope = 'audit-' + scope;
      const errors = Array.isArray(d.errors) ? d.errors : [];
      const warns = Array.isArray(d.warns) ? d.warns : [];
      const notes = Array.isArray(d.notes) ? d.notes : [];
      const pass = errors.length === 0;
      const op = appendOp(m[1], {
        kind: scope === 'audio' ? 'check-audio' : 'check-characters',
        by: d.by || 'cli', page: d.page || null,
        ms: d.ms ?? null,
        summary: scope === 'audio'
          ? `音频脚本检查：${pass ? '通过' : errors.length + ' 个错误'} · ${d.dialogues ?? 0} 条对话 · 阈值 ${Math.round((d.threshold ?? 0.9) * 100)}%`
          : `角色档案检查：${pass ? '通过' : errors.length + ' 个错误'} · ${d.characters ?? 0} 个角色`,
        input: { image: null, box: null, scope },
        output: { image: null, count: d.dialogues ?? d.characters ?? null },
        data: {
          scope: auditScope,
          pass,
          threshold: d.threshold ?? null,
          files: d.files ?? null,
          errors, warns, notes,
          detail: d.detail || null,
        },
      });
      return send(res, 200, { ok: true, opId: op.id, pass });
    }

    // 渲染交给前端（public/vendor/marked.min.js），这里只负责取文件。
    m = p.match(/^\/api\/session\/([^/]+)\/storyboard$/);
    if (m && req.method === 'GET') {
      const dir = sessionDir(m[1]);
      if (!fs.existsSync(dir)) return send(res, 200, { pages: [] });
      const pages = fs.readdirSync(dir)
        .filter((f) => /^[^/\\]+\.md$/i.test(f))
        .sort()
        .map((f) => {
          const file = path.join(dir, f);
          const st = fs.statSync(file);
          return { page: path.basename(f, '.md'), md: fs.readFileSync(file, 'utf8'),
                   size: st.size, mtime: st.mtime.toISOString() };
        });
      return send(res, 200, { pages });
    }

    // 删除单条历史（顺带清理不再被引用的图片）
    m = p.match(/^\/api\/session\/([^/]+)\/history\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      const db = readOps(m[1]);
      const idx = db.ops.findIndex((o) => o.id === m[2]);
      if (idx < 0) return send(res, 404, { error: '记录不存在' });
      const [removed] = db.ops.splice(idx, 1);
      writeJson(OPS_FILE(m[1]), db);
      pruneImages(m[1], removed);
      broadcast('op-removed', { session: m[1], id: m[2] });
      return send(res, 200, { ok: true });
    }

    // 清空历史
    m = p.match(/^\/api\/session\/([^/]+)\/history$/);
    if (m && req.method === 'DELETE') {
      const db = readOps(m[1]);
      writeJson(OPS_FILE(m[1]), { version: 1, ops: [] });
      const imgDir = IMAGES_DIR(m[1]);
      if (fs.existsSync(imgDir)) {
        for (const f of fs.readdirSync(imgDir)) {
          try { fs.rmSync(path.join(imgDir, f), { force: true }); } catch {}
        }
      }
      broadcast('op-cleared', { session: m[1], removed: db.ops.length });
      return send(res, 200, { ok: true, removed: db.ops.length });
    }

    m = p.match(/^\/s\/([^/]+)\/img\/([^/]+)$/);
    if (m) {
      const f = path.join(sessionDir(m[1]), path.basename(m[2]));
      if (!fs.existsSync(f)) return send(res, 404, { error: 'no file' });
      const ext = path.extname(f).toLowerCase();
      const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=60' });
      return fs.createReadStream(f).pipe(res);
    }

    m = p.match(/^\/s\/([^/]+)\/hist-img\/([^/]+)$/);
    if (m) {
      const f = path.join(IMAGES_DIR(m[1]), path.basename(m[2]));
      if (!fs.existsSync(f)) return send(res, 404, { error: 'no image' });
      // 按真实格式返回：历史里会有 PNG / WEBP，全当成 JPEG 发给浏览器会显示成裂图
      const head = Buffer.alloc(12);
      const fd = fs.openSync(f, 'r');
      fs.readSync(fd, head, 0, 12, 0);
      fs.closeSync(fd);
      const ext = imageExt(head);
      const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=600' });
      return fs.createReadStream(f).pipe(res);
    }

    // 历史里的音频（生成结果 / 参考音频）
    m = p.match(/^\/s\/([^/]+)\/hist-audio\/([^/]+)$/);
    if (m) {
      const f = path.join(AUDIO_DIR(m[1]), path.basename(m[2]));
      if (!fs.existsSync(f)) return send(res, 404, { error: 'no audio' });
      const type = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg' }[path.extname(f).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=600' });
      return fs.createReadStream(f).pipe(res);
    }

    // 检查图渲染：灰度原图 + 参考线 + 框叠加，参数见 render_check.py
    if (p === '/render' && req.method === 'GET') {
      const args = JSON.stringify(Object.fromEntries(url.searchParams));
    const png = await new Promise((resolve2, reject2) => execFile(PY(),
[path.join(__dirname, 'render_check.py'), args],
        { maxBuffer: 32 * 1024 * 1024, encoding: 'buffer', windowsHide: true },
        (err, stdout, stderr) => {
          if (err) { reject2(new Error(String(stderr || err).slice(0, 400))); return; }
          resolve2(stdout);
        }));
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      res.end(png);
      return;
    }

    // 设置 + 音频管理工具路由（合并自 tools/settings 与 tools/audio）
    if (await handleToolRoutes(req, res, p, url, {
      body, send,
      loadSettings, saveSettings, publicView, mergeIncoming,
      openaiListModels, checkOpenaiModel, doubaoTts, translatorPing,
      readCharactersRaw, normalizeCharacters, updateCharacter,
      charVoicesView, readAudioScripts, callDoubao, safeToolName, findRefPath,
          cleanBaseUrl, maskKey, loadDoubaoAuth, ROOT: ROOT,
      // 音频生成也要留历史：和识别记录放在同一个 history/ops.json
      appendOp, saveAudio, sha1,
    })) return;

    const f = p === '/' ? path.join(ROOT_DIR, 'public/index.html') : path.join(ROOT_DIR, 'public', p.slice(1));
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[path.extname(f)] || 'application/octet-stream';
      if (p === '/') {
        // 面板模板单独放 public/panel.html，改完立刻生效，不用再手工拼回 index.html
        let html = fs.readFileSync(f, 'utf8');
        const panelFile = path.join(ROOT_DIR, 'public/panel.html');
        if (fs.existsSync(panelFile)) {
          const panel = fs.readFileSync(panelFile, 'utf8');
          html = html.replace(/<!--\s*PANEL\s*-->|<aside class="panel">[\s\S]*?<\/aside>/,
            () => panel);
        }
        return send(res, 200, html, type);
      }
      return send(res, 200, fs.readFileSync(f), type);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    send(res, 500, { error: String(e) });
  }
}).listen(PORT, () => console.log(`canvas http://127.0.0.1:${PORT} root=${ROOT()}`));
