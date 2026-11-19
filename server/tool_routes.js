// tool_routes.js — 设置界面 + 音频管理路由（合并自 tools/settings 与 tools/audio）
// 由 canvas.mjs 调用：handleToolRoutes(req, res, p, url, ctx)，返回 true 表示已处理
import path from 'node:path';
import fs from 'node:fs';
let toolCtx = null;
export async function handleToolRoutes(req, res, p, url, ctx) {
  toolCtx = ctx;
  // ROOT 可能是活的 getter（设置页改 dataDir 后热生效），统一在用时调用。
  const { body, send, loadSettings, saveSettings, publicView, mergeIncoming,
          openaiListModels, checkOpenaiModel, doubaoTts, translatorPing,
          loadDoubaoAuth, readCharactersRaw, normalizeCharacters, updateCharacter,
          charVoicesView, readAudioScripts, callDoubao, safeToolName,
          cleanBaseUrl, maskKey, ROOT, appendOp, saveAudio, sha1 } = ctx;
  const rootNow = () => (typeof ROOT === 'function' ? ROOT() : ROOT);
  try {
    // ---------- 设置界面 ----------
    if (p === '/api/settings' && req.method === 'GET') {
      return send(res, 200, publicView(loadSettings()));
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const incoming = await body(req);
      const merged = mergeIncoming(loadSettings(), incoming);
      saveSettings(merged);
      return send(res, 200, { ok: true, settings: publicView(merged) });
    }
    if (p === '/api/openai/models' && req.method === 'POST') {
      const { baseUrl, apiKey } = await body(req);
      const settings = loadSettings();
      const useKey = apiKey && !apiKey.includes('***') ? apiKey : settings.openai.apiKey;
      const models = await openaiListModels(baseUrl || settings.openai.baseUrl, useKey);
      return send(res, 200, { ok: true, models });
    }
    if (p === '/api/openai/check-model' && req.method === 'POST') {
      const { baseUrl, apiKey, model } = await body(req);
      const settings = loadSettings();
      const useKey = apiKey && !apiKey.includes('***') ? apiKey : settings.openai.apiKey;
      const result = await checkOpenaiModel(baseUrl || settings.openai.baseUrl, useKey, model || settings.openai.model);
      return send(res, 200, { ok: true, result });
    }
    if (p === '/api/doubao/tts-test' && req.method === 'POST') {
      const { mode, text, referenceAudioB64 } = await body(req);
      const settings = loadSettings();
      if (!settings.doubao.apiKey) throw new Error('还没保存豆包 API key');
      const result = await doubaoTts(
        settings.doubao.apiKey,
        settings.doubao.model,
        text || '你好，这是一段设置界面生成的测试音频。',
        mode === 'reference' ? (referenceAudioB64 || settings.doubao.referenceAudio || null) : null,
      );
      return send(res, 200, { ok: true, ...result });
    }
    if (p === '/api/translator/ping' && req.method === 'POST') {
      const { baseUrl } = await body(req);
      const settings = loadSettings();
      const result = await translatorPing(baseUrl || settings.translator.baseUrl);
      return send(res, 200, { ok: true, ...result });
    }
    if (p === '/api/openai/detect-stream' && req.method === 'POST') {
      const { baseUrl, apiKey, model, prompt, imageB64 } = await body(req);
      const settings = loadSettings();
      const useKey = apiKey && !apiKey.includes('***') ? apiKey : settings.openai.apiKey;
      const useBase = baseUrl || settings.openai.baseUrl;
      const useModel = model || settings.openai.model;
      if (!useBase || !useKey || !useModel) throw new Error('base URL / API key / model must be set');
      const content = [{ type: 'text', text: prompt || 'describe this image' }];
      if (imageB64) content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageB64 } });
      let up;
      try {
        up = await fetch(cleanBaseUrl(useBase) + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + useKey },
          body: JSON.stringify({ model: useModel, messages: [{ role: 'user', content }], stream: true }),
        });
      } catch (e) { throw new Error('connect failed: ' + e.message); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      if (!up.ok) {
        const t = await up.text();
        res.write('event: error\ndata: ' + JSON.stringify({ message: 'HTTP ' + up.status + ' ' + t.slice(0, 300) }) + '\n\n');
        return res.end();
      }
      const reader = up.body.getReader();
      const decoder = new TextDecoder();
      let sbuf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sbuf += decoder.decode(value, { stream: true });
        const lines = sbuf.split('\n');
        sbuf = lines.pop();
        for (const line of lines) {
          const t2 = line.trim();
          if (!t2.startsWith('data:')) continue;
          const payload = t2.slice(5).trim();
          if (payload === '[DONE]') { res.write('event: done\ndata: {}\n\n'); continue; }
          try {
            const j = JSON.parse(payload);
            const delta = j.choices && j.choices[0] && j.choices[0].delta ? j.choices[0].delta.content || '' : '';
            if (delta) res.write('event: delta\ndata: ' + JSON.stringify({ text: delta }) + '\n\n');
          } catch {}
        }
      }
      return res.end();
    }

    // ---------- 音频管理 ----------
    if (p === '/api/audio/health' && req.method === 'GET') {
      const auth = loadDoubaoAuth();
      return send(res, 200, { ok: true, keyReady: !auth.error, keyMode: auth.mode || null, keyError: auth.error || null });
    }

    const charsApi = p.match(/^\/api\/(?:audio\/characters|session\/([^/]+)\/characters)$/);
    if (charsApi) {
      const session = decodeURIComponent(charsApi[1] || charsApi[2] || '');
      if (req.method === 'GET') {
        return send(res, 200, { ok: true, characters: await charVoicesView(session) });
      }
      if (req.method === 'POST') {
        const b = await body(req);
        if (!b.name) return send(res, 400, { ok: false, message: '缺少 name' });
        const patch = {};
        if (b.voiceprint_desc !== undefined) patch.voiceprint_desc = String(b.voiceprint_desc);
        await updateCharacter(session, b.name, patch);
        return send(res, 200, { ok: true, characters: await charVoicesView(session) });
      }
    }

    const refApi = p.match(/^\/api\/(?:audio\/ref-audio|session\/([^/]+)\/ref-audio)$/);
    if (refApi && req.method === 'POST') {
      const session = decodeURIComponent(refApi[1] || refApi[2] || '');
      const b = await body(req);
      if (!b.name || !b.slot || !b.dataBase64) return send(res, 400, { ok: false, message: '缺少 name / slot / dataBase64' });
      if (!['api_ref', 'final_ref'].includes(b.slot)) return send(res, 400, { ok: false, message: 'slot 必须是 api_ref 或 final_ref' });
      const ext = ['mp3', 'wav', 'ogg', 'opus', 'pcm'].includes(b.ext) ? b.ext : 'mp3';
      const fname = safeToolName(b.name) + '_' + b.slot + '.' + ext;
    const voicesDir = path.join(rootNow(), session, 'voices');
      fs.mkdirSync(voicesDir, { recursive: true });
      fs.writeFileSync(path.join(voicesDir, fname), Buffer.from(b.dataBase64, 'base64'));
      const field = b.slot === 'api_ref' ? 'api_ref_audio' : 'final_ref_audio';
      await updateCharacter(session, b.name, { [field]: fname });
      return send(res, 200, { ok: true, characters: await charVoicesView(session) });
    }

    const scriptsApi = p.match(/^\/api\/(?:audio\/scripts|session\/([^/]+)\/audio-scripts)$/);
    if (scriptsApi && req.method === 'GET') {
      const session = decodeURIComponent(scriptsApi[1] || scriptsApi[2] || '');
      return send(res, 200, { ok: true, pages: await readAudioScripts(session) });
    }

    const dlgVoicesApi = p.match(/^\/api\/session\/([^/]+)\/dialogue-audios$/);
    if (dlgVoicesApi && req.method === 'GET') {
      const session = decodeURIComponent(dlgVoicesApi[1]);
    const dir = path.join(rootNow(), session, 'voices');
      let files = [];
      try { files = (await fs.promises.readdir(dir)).filter((n) => /^dlg_/.test(n) && n.endsWith('.mp3')); }
      catch { /* 目录不存在 */ }
      return send(res, 200, { ok: true, files });
    }

    if (p === '/api/audio/generate' && req.method === 'POST') {
      const b = await body(req);
      const session = b.session;
      if (!session || !b.name || !['voiceprint', 'dialogue'].includes(b.purpose)) {
        return send(res, 400, { ok: false, message: '缺少 session / name / purpose' });
      }
    const voicesDir = path.join(rootNow(), session, 'voices');
      fs.mkdirSync(voicesDir, { recursive: true });
      const chars = normalizeCharacters(await readCharactersRaw(session));
      const c = chars.find((x) => x.name === b.name);
      let outName;
      let prompt;
      let warning = null;
      if (b.purpose === 'voiceprint') {
        const desc = (c && (c.voiceprint_desc || c.voice_desc)) || '';
        prompt = (desc ? desc + '。' : '') + '示例台词：大家好，很高兴见到你。';
        outName = safeToolName(b.name) + '.mp3';
      } else {
        const text = String(b.text || '').slice(0, 2900);
        if (!text) return send(res, 400, { ok: false, message: '缺少 text' });
        const refFile = (c && (c.final_ref_audio || c.api_ref_audio)) || null;
        let refPath = null;
        if (refFile) {
    const cand = path.join(rootNow(), session, 'voices', refFile);
          try { await fs.promises.access(cand); refPath = cand; } catch { refPath = null; }
        }
        const tone = b.tone ? String(b.tone) : '';
        const perf = b.performance ? String(b.performance).trim() : '';
        if (perf) {
          // 导演式提示词（豆包 audio-1.0 官方范式）：performance 已是完整声音分镜描述，
          // 直接作为前缀，台词自然嵌入其中；不再套「用…的语气」模板
          prompt = perf + (refPath ? ' @音频1 说道："' + text + '"' : '。' + text);
          if (tone) warning = '同时传了 performance 和 tone，本次以 performance 为准';
        } else if (refPath) {
          prompt = (tone ? '用' + tone + '的语气，' : '') + '@音频1 说道："' + text + '"';
        } else {
          prompt = (tone ? tone + '。' : '') + text;
          warning = '该角色没有最终参考音频，使用纯文本生成，音色可能与角色不一致';
        }
        const refTag = String(b.ref || '').replace('@', '');
        outName = safeToolName('dlg_' + (b.page || 'x') + '_' + (refTag || Date.now()) + '_' + b.name) + '.mp3';
      }
      const refPath = b.purpose === 'dialogue' ? await findRefPath(session, b.name) : null;
      const result = await callDoubao(prompt, refPath);
      fs.writeFileSync(path.join(voicesDir, outName), result.buffer);
      if (b.purpose === 'voiceprint') {
        await updateCharacter(session, b.name, {
          voiceprint_audio: outName,
          final_ref_audio: outName,
        });
      }
      // 历史：把真正发给豆包的提示词、参考音频和其他参数一起存下来
      let opId = null;
      if (appendOp) {
        const audioFile = saveAudio(session, result.buffer, 'gen');
        let refAudio = null;
        if (result.refBuffer) {
          const ext = path.extname(result.refPath || '').toLowerCase() || '.mp3';
          refAudio = {
            file: saveAudio(session, result.refBuffer, 'ref', ext),
            name: path.basename(result.refPath || ''),
            bytes: result.refBuffer.length,
          };
        }
        const op = appendOp(session, {
          kind: b.purpose === 'voiceprint' ? 'audio-vp' : 'audio-dlg',
          by: 'ui', page: b.page || null,
          ms: null,
          summary: b.purpose === 'voiceprint'
            ? `生成声纹：${b.name}${result.duration ? ' · ' + result.duration + 's' : ''}`
            : `生成对话：${b.name} · ${String(b.text || '').slice(0, 16)}`,
          input: { image: null, box: null, scope: 'audio' },
          output: { image: null, count: null },
          audio: { file: audioFile, url: `/voices/${encodeURIComponent(session)}/${encodeURIComponent(outName)}`, duration: result.duration ?? null },
          data: {
            scope: 'audio',
            purpose: b.purpose,
            character: b.name,
            text: b.text || null,
            prompt,
            performance: b.performance || null,
            tone: b.tone || null,
            ref: b.ref || null,
            request: result.request,
            warning,
            refAudio,
          },
        });
        opId = op.id;
      }
      return send(res, 200, {
        ok: true,
        url: '/voices/' + encodeURIComponent(session) + '/' + encodeURIComponent(outName),
        duration: result.duration,
        warning,
        opId,
      });
    }

    // voices 静态音频
    const vs = p.match(/^\/voices\/([^/]+)\/(.+)$/);
    if (vs && req.method === 'GET') {
    const filePath = path.join(rootNow(), decodeURIComponent(vs[1]), 'voices', path.basename(decodeURIComponent(vs[2])));
      const type = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg' }[path.extname(filePath)] || 'application/octet-stream';
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': type });
        return fs.createReadStream(filePath).pipe(res);
      }
      return send(res, 404, { ok: false, message: '音频不存在' });
    }

    return false;
  } catch (e) {
    if (e.code === 'NO_KEY') return send(res, 400, { ok: false, code: 'NO_KEY', message: e.message });
    throw e;
  }
}

// 查找角色参考音频的绝对路径；无则返回 null
async function findRefPath(session, name) {
  const chars = toolCtx.normalizeCharacters(await toolCtx.readCharactersRaw(session));
  const c = chars.find((x) => x.name === name);
  const refFile = c && (c.final_ref_audio || c.api_ref_audio);
  if (!refFile) return null;
    const cand = path.join(rootNow(), session, 'voices', refFile);
  try { await fs.promises.access(cand); return cand; } catch { return null; }
}

