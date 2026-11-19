
// ============================================================
// 设置界面 + 音频管理（合并自 tools/settings 与 tools/audio 独立服务）
// API key 存 settings.json（后端读写），返回前端时脱敏。
// 页面：public/settings.html、public/audio.html（同源 /api、/vendor）。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT_DIR_TOOLS = 'I:/comic-canvas';
const ROOT = ROOT_DIR_TOOLS + '/sessions';
const SETTINGS_FILE = path.join(ROOT_DIR_TOOLS, 'settings.json');
const DOUBAO_URL = 'https://openspeech.bytedance.com/api/v3/tts/create';

const DEFAULT_SETTINGS = {
  openai: { baseUrl: '', apiKey: '', model: '' },
  doubao: { apiKey: '', model: 'seed-audio-1.0', voice: '', referenceAudio: '' },
  translator: { baseUrl: 'http://127.0.0.1:5009', projectRoot: '' },
};

const maskKey = (key) => {
  if (!key) return '';
  if (key.length <= 8) return '***';
  return key.slice(0, 3) + '***' + key.slice(-4);
};

const cleanBaseUrl = (u) => (u || '').trim().replace(/\/+$/, '');

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return {
      openai: { ...DEFAULT_SETTINGS.openai, ...(raw.openai || {}) },
      doubao: { ...DEFAULT_SETTINGS.doubao, ...(raw.doubao || {}) },
      translator: { ...DEFAULT_SETTINGS.translator, ...(raw.translator || {}) },
    };
  } catch { return structuredClone(DEFAULT_SETTINGS); }
}

function saveSettings(next) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
}

const publicView = (s) => ({
  ...s,
  openai: { ...s.openai, apiKey: maskKey(s.openai.apiKey) },
  doubao: { ...s.doubao, apiKey: maskKey(s.doubao.apiKey) },
});

// 前端提交 "" 时保留旧 key（脱敏值不回传真实 key）
const mergeIncoming = (current, incoming) => {
  const merged = structuredClone(current);
  for (const section of ['openai', 'doubao', 'translator']) {
    for (const [k, v] of Object.entries(incoming?.[section] || {})) {
      if (k === 'apiKey' || k === 'referenceAudio') {
        if (typeof v === 'string' && v.length > 0) merged[section][k] = v;
      } else {
        merged[section][k] = v;
      }
    }
  }
  return merged;
};

async function openaiListModels(baseUrl, apiKey) {
  if (!baseUrl || !apiKey) throw new Error('base URL / API key must be set');
  const url = cleanBaseUrl(baseUrl) + '/models';
  let resp, data;
  try {
    resp = await fetch(url, { headers: { Authorization: 'Bearer ' + apiKey } });
    data = await resp.json().catch(() => null);
  } catch (e) {
    throw new Error('连接失败: ' + e.message);
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status + (data?.error?.message ? ' | ' + data.error.message : ''));
  const list = Array.isArray(data?.data) ? data.data.map((m) => m.id).filter(Boolean) : null;
  if (!list || !list.length) throw new Error('响应里没有模型列表, data 数组为空');
  return list.sort();
}

async function checkOpenaiModel(baseUrl, apiKey, model) {
  if (!baseUrl || !apiKey || !model) throw new Error('base URL / API key / model must be set');
  const url = cleanBaseUrl(baseUrl) + '/chat/completions';
  let resp, data;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
    });
    data = await resp.json().catch(() => null);
  } catch (e) {
    throw new Error('connect failed: ' + e.message);
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status + (data?.error?.message ? ' | ' + data.error.message : ''));
  if (!data?.id && !data?.choices) throw new Error('unexpected response, not a chat completion');
  return data.choices?.[0]?.message || { note: 'ok' };
}

async function doubaoTts(apiKey, model, textPrompt, referenceAudioB64) {
  const payload = {
    model: model || 'seed-audio-1.0',
    text_prompt: textPrompt,
    audio_config: { format: 'mp3', sample_rate: 48000 },
  };
  if (referenceAudioB64) {
    payload.references = [{ audio_data: referenceAudioB64 }];
    payload.text_prompt = '@音频1 ' + textPrompt;
  }
  let resp, data;
  try {
    resp = await fetch(DOUBAO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        'X-Api-Request-Id': crypto.randomUUID(),
      },
      body: JSON.stringify(payload),
    });
    data = await resp.json();
  } catch (e) {
    throw new Error('连接失败: ' + e.message);
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status + (data?.message ? '：' + data.message : ''));
  if (data.code != null && data.code !== 0) throw new Error('code ' + data.code + '：' + (data.message || '未知错误'));
  if (!data.audio) throw new Error('返回里没有音频数据' + (data.message ? '：' + data.message : ''));
  return { duration: data.duration, originalDuration: data.original_duration, audioB64: data.audio };
}

async function translatorPing(baseUrl) {
  if (!baseUrl) throw new Error('先填 OCR 服务地址');
  const url = cleanBaseUrl(baseUrl) + '/health';
  let resp, data;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    data = await resp.json().catch(() => null);
  } catch (e) {
    throw new Error('连接失败: ' + e.message + '（服务可能没启动）');
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return { status: data?.status || 'ok', detail: data };
}

// ---------- 音频管理：characters.json / audio_scripts / 豆包生成 ----------
function loadDoubaoAuth() {
  let raw;
  try { raw = fs.readFileSync(SETTINGS_FILE, 'utf8'); }
  catch { return { error: 'missing' }; }
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch { return { error: 'invalid' }; }
  const d = cfg.doubao || cfg.Doubao || cfg.DOUBAO || {};
  const apiKey = d.apiKey || d.api_key || cfg.doubao_api_key || cfg.DOUBAO_API_KEY || cfg.doubaoApiKey;
  const appId = d.appId || d.app_id || cfg.doubao_app_id || cfg.DOUBAO_APP_ID;
  const accessKey = d.accessKey || d.access_key || cfg.doubao_access_key || cfg.DOUBAO_ACCESS_KEY;
  if (apiKey) return { headers: { 'X-Api-Key': String(apiKey) }, mode: 'new' };
  if (appId && accessKey) return { headers: { 'X-Api-App-Id': String(appId), 'X-Api-Access-Key': String(accessKey) }, mode: 'legacy' };
  return { error: 'no_key' };
}

function charFile(session) { return path.join(ROOT, session, 'characters.json'); }

async function readCharactersRaw(session) {
  try { return JSON.parse(await fs.promises.readFile(charFile(session), 'utf8')); }
  catch { return null; }
}

function normalizeCharacters(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.characters)) list = raw.characters;
  else if (raw && typeof raw === 'object') {
    list = Object.entries(raw).map(([name, v]) =>
      typeof v === 'object' && v !== null ? Object.assign({ name }, v) : { name, voiceprint_desc: String(v) });
  }
  return list.filter((c) => c && c.name);
}

async function updateCharacter(session, name, patch) {
  let raw = await readCharactersRaw(session);
  const apply = (obj) => Object.assign(obj, patch);
  if (!raw) {
    raw = {};
    raw[name] = Object.assign({}, patch);
  } else if (Array.isArray(raw)) {
    const e = raw.find((c) => c && c.name === name);
    if (e) apply(e); else raw.push(Object.assign({ name }, patch));
  } else if (raw && Array.isArray(raw.characters)) {
    const e = raw.characters.find((c) => c && c.name === name);
    if (e) apply(e); else raw.characters.push(Object.assign({ name }, patch));
  } else if (typeof raw === 'object') {
    if (!raw[name] || typeof raw[name] !== 'object') raw[name] = {};
    apply(raw[name]);
  } else {
    throw new Error('characters.json 格式无法识别');
  }
  await fs.promises.writeFile(charFile(session), JSON.stringify(raw, null, 2), 'utf8');
  return raw;
}

async function charVoicesView(session) {
  const raw = await readCharactersRaw(session);
  const voicesDir = path.join(ROOT, session, 'voices');
  const list = normalizeCharacters(raw);
  return Promise.all(list.map(async (c) => {
    const pick = async (p) => {
      if (!p) return null;
      try { await fs.promises.access(path.join(voicesDir, p)); return '/voices/' + encodeURIComponent(session) + '/' + encodeURIComponent(p); }
      catch { return null; }
    };
    return {
      name: c.name,
      appearance: c.appearance || '',
      voiceprint_desc: c.voiceprint_desc || c.voice_desc || c.voiceprint || '',
      api_ref_audio: c.api_ref_audio || null,
      final_ref_audio: c.final_ref_audio || null,
      voiceprint_audio: c.voiceprint_audio || null,
      api_ref_url: await pick(c.api_ref_audio),
      final_ref_url: await pick(c.final_ref_audio),
      voiceprint_url: await pick(c.voiceprint_audio),
    };
  }));
}

async function readAudioScripts(session) {
  const dir = path.join(ROOT, session);
  let names = [];
  try { names = (await fs.promises.readdir(dir)).filter((n) => /^\d{5}_audio_scripts\.json$/.test(n)).sort(); }
  catch { /* 会话目录不存在 */ }
  const pages = [];
  for (const n of names) {
    try {
      const data = JSON.parse(await fs.promises.readFile(path.join(dir, n), 'utf8'));
      pages.push({
        page: String(data.page || n.slice(0, 5)),
        characters: data.characters || {},
        dialogues: Array.isArray(data.dialogues) ? data.dialogues : [],
      });
    } catch (e) {
      pages.push({ page: n.slice(0, 5), characters: {}, dialogues: [], error: '读取失败: ' + e.message });
    }
  }
  return pages;
}

async function callDoubao(prompt, refPath) {
  const auth = loadDoubaoAuth();
  if (auth.error) {
    const msg = auth.error === 'missing'
      ? '未找到 I:\comic-canvas\settings.json。请先在「设置界面」配置豆包 API Key。'
      : 'settings.json 中未找到豆包 API Key。请先在「设置界面」完成配置。';
    const err = new Error(msg);
    err.code = 'NO_KEY';
    throw err;
  }
  const payload = {
    model: 'seed-audio-1.0',
    text_prompt: prompt,
    audio_config: { format: 'mp3', sample_rate: 44100 },
    watermark: {},
  };
  if (refPath) {
    const buf = await fs.promises.readFile(refPath);
    if (buf.length > 10 * 1024 * 1024) throw new Error('参考音频超过 10MB 上限');
    payload.references = [{ audio_data: buf.toString('base64') }];
  }
  const resp = await fetch(DOUBAO_URL, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'X-Api-Request-Id': crypto.randomUUID() }, auth.headers),
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('豆包返回非 JSON（HTTP ' + resp.status + '): ' + text.slice(0, 300)); }
  if (data.code !== undefined && data.code !== 0 && data.code !== null) {
    throw new Error('豆包错误 ' + data.code + ': ' + (data.message || '未知错误'));
  }
  const b64 = data.audio || data.data;
  if (!b64) throw new Error('豆包未返回音频: ' + (data.message || text.slice(0, 200)));
  return { buffer: Buffer.from(b64, 'base64'), duration: data.duration || null };
}

function safeToolName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'unnamed';
}

async function findRefPath(session, name) {
  const chars = normalizeCharacters(await readCharactersRaw(session));
  const c = chars.find((x) => x.name === name);
  const refFile = c && (c.final_ref_audio || c.api_ref_audio);
  if (!refFile) return null;
  const cand = path.join(ROOT, session, 'voices', refFile);
  try { await fs.promises.access(cand); return cand; } catch { return null; }
}

export { loadSettings, saveSettings, publicView, mergeIncoming,
         openaiListModels, checkOpenaiModel, doubaoTts, translatorPing,
         loadDoubaoAuth, readCharactersRaw, normalizeCharacters, updateCharacter,
         charVoicesView, readAudioScripts, callDoubao, safeToolName, findRefPath,
         cleanBaseUrl, maskKey };

