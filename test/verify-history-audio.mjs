// 验证：音频生成会写一条历史，包含原始提示词、参考音频和参数。
// 用假的 callDoubao，不会真的请求豆包、不花钱。
import fs from 'node:fs';
import path from 'node:path';
import { handleToolRoutes } from '../server/tool_routes.js';
import { callDoubao, safeToolName, findRefPath, readCharactersRaw,
         normalizeCharacters, updateCharacter, charVoicesView, readAudioScripts,
         loadSettings, saveSettings, publicView, mergeIncoming, maskKey,
         loadDoubaoAuth } from '../server/tools_helpers.js';

const ROOT = 'I:/comic-canvas/sessions';
const session = '_histtest_' + Date.now();
const dir = path.join(ROOT, session);
fs.mkdirSync(path.join(dir, 'voices'), { recursive: true });
fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify({
  测试角色: { name: '测试角色', voiceprint_desc: '青年男声' },
}));
const refBytes = Buffer.from('fake-ref-audio');
fs.writeFileSync(path.join(dir, 'voices', '测试角色_final_ref.mp3'), refBytes);

let opRecord = null;
const ctx = {
  body: async () => ({ session, name: '测试角色', purpose: 'dialogue', text: '你好',
                       performance: '低声道', ref: '@对话1', page: '00001' }),
  send: (res, code, data) => { res.code = code; res.data = data; },
  loadSettings, saveSettings, publicView, mergeIncoming,
  openaiListModels: null, checkOpenaiModel: null, doubaoTts: null, translatorPing: null,
  loadDoubaoAuth, readCharactersRaw, normalizeCharacters, updateCharacter,
  charVoicesView, readAudioScripts,
  callDoubao: async () => ({ buffer: Buffer.from('out-audio'), duration: 1.5,
    request: { model: 'seed-audio-1.0', text_prompt: 'x' }, refBuffer: refBytes,
    refPath: path.join(dir, 'voices', '测试角色_final_ref.mp3') }),
  safeToolName, findRefPath, cleanBaseUrl: (u) => u, maskKey, ROOT,
  appendOp: (s, op) => { opRecord = { ...op, id: 'test-op' }; return opRecord; },
  saveAudio: (s, buf, tag, ext = '.mp3') => {
    const n = tag + '-' + buf.length + ext;
    fs.mkdirSync(path.join(ROOT, s, 'history', 'audio'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, s, 'history', 'audio', n), buf);
    return n;
  },
  sha1: () => 'x',
};

const req = { method: 'POST' };
const res = {};
await handleToolRoutes(req, res, '/api/audio/generate', new URL('http://x/api/audio/generate'), ctx);

const ok = [];
const fail = [];
const check = (name, cond) => (cond ? ok : fail).push(name);
check('接口返回 ok', res.data?.ok === true);
check('返回 opId', !!res.data?.opId);
check('历史 kind=audio-dlg', opRecord?.kind === 'audio-dlg');
check('历史保存了提示词', typeof opRecord?.data?.prompt === 'string' && opRecord.data.prompt.length > 0);
check('历史保存了生成音频', !!opRecord?.audio?.file);
check('历史保存了参考音频', !!opRecord?.data?.refAudio?.file);
check('历史保存了请求参数', opRecord?.data?.request?.model === 'seed-audio-1.0');
check('音频文件已落盘', fs.existsSync(path.join(dir, 'history', 'audio', opRecord.audio.file)));

fs.rmSync(dir, { recursive: true, force: true });
console.log(ok.map((n) => '✓ ' + n).join('\n'));
if (fail.length) { console.log(fail.map((n) => '✗ ' + n).join('\n')); process.exit(1); }
console.log(`音频历史 ${ok.length} 项全过`);
