/**
 * storyboard.js — 右侧面板「分镜」tab 的渲染器。
 *
 * 数据来源：GET /api/session/<画布>/storyboard
 *   返回该画布下所有 NNNNN.md 的原文（canvas_cli.py 写出的分镜稿）。
 *
 * 为什么单独一个文件：
 *   面板模板 panel.html 和画布 canvas.js 由多个对话共用。这段渲染只关心
 *   「拿到 md → 画出来」，单独放一处，改它就不会碰到别人负责的逻辑。
 *
 * 用法：panel.html 里放一个空的 <div id="storyboard-root" data-session data-page>，
 * 本脚本发现它出现后，自己在里面画界面。
 */
(function () {
  const ROOT_ID = 'storyboard-root';
  const cache = new Map();          // session -> { at, pages: [{page, md}] }
  const state = { session: null, page: null, loading: false, error: '', pages: [] };
  let currentRoot = null;
  let lastKey = '';

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const inline = (s) => (window.marked ? marked.parseInline(esc(s)) : esc(s));

  // ---------- markdown 解析 ----------
  // 把一段 md 拆成「按 ## 分节」的结构，分镜一节再按 ### 拆成一个个镜头。
  function splitSections(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const head = { title: '', body: [] };
    const sections = [];
    let cur = head;
    for (const line of lines) {
      const h1 = line.match(/^#\s+(.+)$/);
      const h2 = line.match(/^##\s+(.+)$/);
      if (h1) { head.title = h1[1].trim(); continue; }
      if (h2) {
        cur = { title: h2[1].trim(), body: [] };
        sections.push(cur);
        continue;
      }
      cur.body.push(line);
    }
    return { head, sections };
  }

  // 一组文本行 → 列表项 / 引用 / 表格 / 段落
  function blocksOf(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) { i++; continue; }
      if (/^\|/.test(line)) {                     // 表格
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i].trim())) { rows.push(lines[i].trim()); i++; }
        out.push({ kind: 'table', rows });
        continue;
      }
      if (/^>/.test(line)) {                      // 引用（台词）
        const q = [];
        while (i < lines.length && /^>/.test(lines[i].trim())) {
          q.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        out.push({ kind: 'quote', lines: q.filter(Boolean) });
        continue;
      }
      if (/^[-*]\s+/.test(line)) {                 // 列表
        const items = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
          i++;
        }
        out.push({ kind: 'ul', items });
        continue;
      }
      const sub = line.match(/^#{3,6}\s+(.+)$/);    // 小节标题（### 场景 A …）
      if (sub) { out.push({ kind: 'h', text: sub[1].trim() }); i++; continue; }
      const para = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (!t || /^[-*]\s+/.test(t) || /^>/.test(t) || /^\|/.test(t) || /^#{3,6}\s/.test(t)) break;
        para.push(t);
        i++;
      }
      // 兜底：一行都没吃掉（比如整行只有一个奇怪前缀）就前进一行，绝不死循环
      if (!para.length) { out.push({ kind: 'p', text: line }); i++; continue; }
      out.push({ kind: 'p', text: para.join(' ') });
    }
    return out;
  }

  // 「画面：xxx」这种行拆成左右两栏，读起来像分镜表的表头
  function kvSplit(text) {
    const t = String(text);
    const k = t.match(/^([^：:]{1,10})[：:]\s*(.*)$/);
    if (!k) return null;
    return { key: k[1].trim(), val: k[2].trim() };
  }

  function tableHtml(rows) {
    const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const body = rows.filter((r, idx) => {
      // 第二行是 | --- | --- | 这种分隔线
      if (idx === 1 && rows.length > 1) return !/^\|?[\s:-]+\|/.test(r.replace(/\s/g, ''));
      return true;
    });
    const [headRow, ...rest] = body;
    if (!headRow) return '';
    const th = cells(headRow).map((c) => '<th>' + inline(c) + '</th>').join('');
    const trs = rest.map((r) => '<tr>' + cells(r).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('');
    return '<div class="bd-tbl"><table><thead><tr>' + th + '</tr></thead><tbody>' + trs + '</tbody></table></div>';
  }

  // 台词：「角色：内容」→ 名字加粗，正文另起一栏
  function quoteHtml(lines) {
    return lines.map((q) => {
      const k = kvSplit(q);
      if (!k) return '<div class="bd-line"><span class="bd-say">' + inline(q) + '</span></div>';
      return '<div class="bd-line"><span class="bd-who">' + inline(k.key) + '</span>'
        + '<span class="bd-say">' + inline(k.val) + '</span></div>';
    }).join('');
  }

  function blocksHtml(blocks) {
    return blocks.map((b) => {
      if (b.kind === 'h') return '<div class="bd-sub">' + inline(b.text) + '</div>';
      if (b.kind === 'talk') {
        // 「对话：」下面紧跟的引用块，合到同一行标签里
        return '<div class="bd-kv bd-kv-talk"><span class="bd-k">对话</span>'
          + '<span class="bd-v">' + quoteHtml(b.lines) + '</span></div>';
      }
      if (b.kind === 'table') return tableHtml(b.rows);
      if (b.kind === 'quote') return quoteHtml(b.lines);
      if (b.kind === 'ul') {
        return '<ul>' + b.items.map((it) => {
          const k = kvSplit(it);
          if (!k) return '<li>' + inline(it) + '</li>';
          return '<li class="bd-kv"><span class="bd-k">' + esc(k.key) + '</span>'
            + '<span class="bd-v">' + inline(k.val) + '</span></li>';
        }).join('') + '</ul>';
      }
      return '<p>' + inline(b.text) + '</p>';
    }).join('');
  }

  // 「对话：」这一行本身没有内容，内容是紧跟的引用块；
  // 合并成一个「对话」标签块，否则会多出一行空的「对话」。
  function mergeTalk(blocks) {
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.kind === 'ul') {
        const items = b.items.slice();
        const last = items[items.length - 1];
        const kv = last ? kvSplit(last) : null;
        if (kv && /^对话$/.test(kv.key) && !kv.val && blocks[i + 1]?.kind === 'quote') {
          items.pop();
          if (items.length) out.push({ kind: 'ul', items });
          out.push({ kind: 'talk', lines: blocks[i + 1].lines });
          i++;
          continue;
        }
      }
      out.push(b);
    }
    return out;
  }

  // 「分镜」一节：每个 ### 是一张卡片
  function shotsHtml(lines) {
    const groups = [];
    let cur = null;
    for (const line of lines) {
      const h3 = line.match(/^###\s+(.+)$/);
      if (h3) { cur = { title: h3[1].trim(), body: [] }; groups.push(cur); continue; }
      // 旧格式：没有 ### 小节，每段以 **P1**（约 6% 高度起）画面… 开头
      const boldP = line.trim().match(/^\*\*(P?\d+[^*]*)\*\*\s*(.*)$/);
      if (boldP) {
        cur = { title: boldP[1].trim(), body: [boldP[2]], old: true };
        groups.push(cur);
        continue;
      }
      if (cur) cur.body.push(line);
    }
    return groups.map((g) => {
      if (g.old) {
        // 老格式没有「画面 / 对话」分行，整段当正文，@对话N 保留成小标签
        const text = g.body.join(' ').trim();
        const body = text.split(/(@对话\d+)/).map((part) =>
          /^@对话\d+$/.test(part)
            ? '<span class="bd-ref">' + esc(part) + '</span>'
            : inline(part)).join('');
        const m0 = g.title.match(/^(P?\d+)$/i);
        return '<section class="bd-card"><h3>'
          + (m0 ? '<span class="bd-badge">' + esc(m0[1]) + '</span>' : '')
          + '<span>分镜</span></h3><p>' + body + '</p></section>';
      }
      const blocks = blocksOf(g.body);
      const merged = mergeTalk(blocks);
      const story = merged.filter((b) => b.kind !== 'quote');
      const talk = merged.filter((b) => b.kind === 'quote');
      // 标题开头的编号（P1 / P2…）做成小角标
      const m = g.title.match(/^(P\d+|[0-9]+)\s*[·・.]\s*(.*)$/i);
      const badge = m ? '<span class="bd-badge">' + esc(m[1]) + '</span>' : '';
      const name = m ? m[2] : g.title;
      return '<section class="bd-card"><h3>' + badge + '<span>' + inline(name) + '</span></h3>'
        + blocksHtml(story) + (talk.length ? blocksHtml(talk) : '') + '</section>';
    }).join('');
  }

  function mdToHtml(md) {
    const { head, sections } = splitSections(md);
    let html = '';
    if (head.title) html += '<h1>' + inline(head.title) + '</h1>';
    html += blocksHtml(blocksOf(head.body));
    for (const sec of sections) {
      const title = sec.title;
      html += '<h2>' + esc(title) + '</h2>';
      if (/分镜|storyboard/i.test(title)) html += shotsHtml(sec.body);
      else html += blocksHtml(blocksOf(sec.body));
    }
    return html;
  }

  // ---------- 数据 ----------
  async function load(session, force) {
    if (!session) return [];
    const hit = cache.get(session);
    if (!force && hit && Date.now() - hit.at < 15000) return hit.pages;
    try {
      const r = await fetch('/api/session/' + encodeURIComponent(session) + '/storyboard', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const pages = d.pages || [];
      cache.set(session, { at: Date.now(), pages });
      return pages;
    } catch (e) {
      cache.set(session, { at: Date.now(), pages: [], error: String(e.message || e) });
      throw e;
    }
  }

  // ---------- 界面 ----------
  function mount(root) {
    root.innerHTML = [
      '<div class="sb-bar"><span class="material-symbols-outlined" style="font-size:15px;color:#999">movie</span>',
      '<span class="sb-name" data-role="name">—</span>',
      '<span class="sp"></span>',
      '<button class="mini2" data-role="reload" title="重新读取 md">',
      '<span class="material-symbols-outlined" style="font-size:12px;vertical-align:-2px">refresh</span></button>',
      '</div>',
      '<div class="sb-chips" data-role="chips"></div>',
      '<div class="sb-doc" data-role="doc"></div>',
    ].join('');
    root.querySelector('[data-role="reload"]').addEventListener('click', () => {
      refresh(root, true);
    });
  }

  function renderChips(root) {
    const box = root.querySelector('[data-role="chips"]');
    if (!box) return;
    box.innerHTML = state.pages.map((p) =>
      '<button data-page="' + esc(p.page) + '" class="' + (p.page === state.page ? 'on' : '') + '">'
      + esc(p.page) + '</button>').join('');
    for (const b of box.querySelectorAll('button')) {
      b.addEventListener('click', () => {
        state.page = b.dataset.page;
        renderChips(root);
        renderDoc(root);
      });
    }
  }

  function renderDoc(root) {
    const doc = root.querySelector('[data-role="doc"]');
    const name = root.querySelector('[data-role="name"]');
    if (!doc) return;
    if (name) name.textContent = state.session || '—';
    if (state.loading) { doc.innerHTML = '<div class="sb-empty">读取中…</div>'; return; }
    if (state.error) { doc.innerHTML = '<div class="sb-empty">读取失败：' + esc(state.error) + '</div>'; return; }
    const cur = state.pages.find((p) => p.page === state.page);
    doc.innerHTML = cur ? mdToHtml(cur.md) : '<div class="sb-empty">这个画布还没有分镜 md</div>';
  }

  async function refresh(root, force) {
    const session = root.getAttribute('data-session') || '';
    const page = root.getAttribute('data-page') || '';
    const changed = session !== state.session;
    state.session = session;
    if (changed) { state.pages = []; state.page = page; }
    state.loading = true;
    state.error = '';
    state.page = state.page || page;
    renderChips(root);
    renderDoc(root);
    try {
      const pages = await load(session, force);
      state.pages = pages;
      // 画布上选中的页有 md，就自动跳过去
      if (page && pages.some((p) => p.page === page)) state.page = page;
      if (!pages.some((p) => p.page === state.page)) state.page = pages[0]?.page || '';
    } catch (e) {
      state.error = String(e.message || e);
    }
    state.loading = false;
    renderChips(root);
    renderDoc(root);
  }

  function tick() {
    const root = document.getElementById(ROOT_ID);
    if (!root) { currentRoot = null; lastKey = ''; return; }
    if (root !== currentRoot) { currentRoot = root; mount(root); lastKey = ''; }
    const key = (root.getAttribute('data-session') || '') + '|' + (root.getAttribute('data-page') || '');
    if (key !== lastKey) {
      lastKey = key;
      const page = root.getAttribute('data-page') || '';
      // 页面变化时：有新页就走新页，避免每次刷新都把用户切走
      if (page && state.pages.some((p) => p.page === page)) state.page = page;
      refresh(root, false);
    }
  }

  // 面板是 v-if 切换的，节点会被销毁重建。
  // 这里只监听「点击面板按钮」和 DOM 变化，不做定时轮询。
  function schedule() {
    if (schedule.pending) return;
    schedule.pending = true;
    setTimeout(() => { schedule.pending = false; tick(); }, 30);
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.panel-head')) schedule();
  }, true);
  if (window.MutationObserver) {
    new MutationObserver(schedule).observe(document.documentElement,
      { childList: true, subtree: true });
  }
  window.addEventListener('load', schedule);
  schedule();
  // 给测试用：node 里可以直接调 mdToHtml 看输出
  window.__STORYBOARD = { mdToHtml, blocksOf, splitSections };
})();
