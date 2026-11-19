const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount, getCurrentInstance, nextTick } = Vue;

createApp({
  setup() {
    const g = getCurrentInstance().appContext.config.globalProperties;
    const notify = g.$notify;
    // $confirm / $notify 必须在 setup 期间取好：点击回调里 getCurrentInstance() 是 null
    const confirmBox = g.$confirm.bind(g);
    const cv = ref(null);
    // 区域面板中间那段滚动列表（顶部按钮、底部编辑框都在它外面）
    const detailScroll = ref(null);
    const S = reactive({
      session: '', sessions: [], pages: [],
      scale: 0.3, tx: 0, ty: 0,
      mode: 'pan', selPage: -1, selBox: -1, selExtra: [],
      drag: null, hover: null,
    });
    // 左上角画布下拉：kit-select 的 options 需要 {label, value}
    const sessionOptions = computed(() => S.sessions.map((s) => ({ label: s, value: s })));
    // 正在识别的框：key = 页码:框坐标，值是任务 id。画布和区域列表都靠它显示加载状态
    const pending = reactive(new Map());
    // 正在处理的整页任务：key = page:页码（整页找框/整页识别/区域找框/区域识别）
    const pageBusy = reactive(new Map());
    // 正在处理的「区域」任务：key = 页码，value = { box, mode }。只在画出来的那块区域里显示
    const regionBusy = reactive(new Map());
    // 动画统一按「真实时间」走，不按帧计数——否则容器大小不同速度就不同
    let nowSec = 0;                      // 由 rAF 更新的秒数
    let animT0 = 0;
    const boxKey = (page, box) => page + ':' + box.map((v) => Math.round(Number(v))).join(',');
    const isPending = (page, box) => pending.has(boxKey(page, box));
    const pageIsBusy = (page) => pageBusy.has('page:' + page);
    const pageBusyMode = (page) => pageBusy.get('page:' + page)?.mode || '';

    const dirty = reactive(new Set());
    const sseOn = ref(false);
    const cursor = ref('—');
    const sideTab = ref('detail');
    const editText = ref('');
    const busy = ref(false);
    const jobs = ref([]);
    const history = ref([]);
    const histFilter = ref('all');
    const ICON = { ocr: 'document_scanner', 'ocr-box': 'select_all', detect: 'crop_free',
      'box-add': 'add_box', 'box-del': 'delete', 'box-edit': 'edit',
      'box-clear': 'delete_sweep', 'box-erase': 'ink_eraser',
      'audio-vp': 'graphic_eq', 'audio-dlg': 'record_voice_over',
      'ai-check': 'visibility' };
    const MODE_LABEL = {
      'detect-page': '整页找框', 'detect-region': '区域找框',
      'ocr-page': '整页识别', 'ocr-region': '区域识别', 'ocr-boxes': '框内文字',
    };
    const openOps = reactive(new Set());
    const preview = ref(null);      // {url, title} 或 {json, title}
    const previewOpen = ref(false);
const toolDialog = reactive({ open: false, full: false, url: '', title: '' });
function openToolDialog(kind) {
  if (kind === 'settings') { toolDialog.url = '/settings.html'; toolDialog.title = '设置'; }
  // 音频页默认打开「当前画布」：把会话名放到地址上，audio.html 会优先读它
  else if (kind === 'audio') { toolDialog.url = '/audio.html?s=' + encodeURIComponent(S.session); toolDialog.title = '音频管理'; }
  else return;
  toolDialog.full = false;
  toolDialog.open = true;
}
    const previewTitle = ref('');
    const uploadRef = ref(null);
    const newName = ref('');
    const showNew = ref(false);
    let latch = null;

    const GAP = 64, TOP = 34, BOTTOM = 34;

    function layout() {
      let x = 0, y = 0, rowH = 0;
      for (const p of S.pages) {
        if (x + p.width * 0.5 > 5200) { x = 0; y += rowH + GAP + TOP + BOTTOM; rowH = 0; }
        p.x = x; p.y = y;
        x += p.width + GAP;
        rowH = Math.max(rowH, p.height);
      }
      const rows = new Map();
      for (const p of S.pages) {
        if (!rows.has(p.y)) rows.set(p.y, []);
        rows.get(p.y).push(p);
      }
      if (!rows.size) return;
      const widest = Math.max(...[...rows.values()].map((l) =>
        Math.max(...l.map((p) => p.x + p.width)) - Math.min(...l.map((p) => p.x))));
      for (const l of rows.values()) {
        const w = Math.max(...l.map((p) => p.x + p.width)) - Math.min(...l.map((p) => p.x));
        for (const p of l) p.x += (widest - w) / 2;
      }
    }

    let ctx = null;
    const ERASE_R = 10;            // 橡皮擦笔刷半径（屏幕 px）
    const vw = () => cv.value?.clientWidth || 1;
    const vh = () => cv.value?.clientHeight || 1;
    const toWorld = (px, py) => ({ x: (px - S.tx) / S.scale, y: (py - S.ty) / S.scale });
    const pageAt = (wx, wy) => {
      for (let i = S.pages.length - 1; i >= 0; i--) {
        const p = S.pages[i];
        if (wx >= p.x && wx <= p.x + p.width && wy >= p.y && wy <= p.y + p.height) return i;
      }
      return -1;
    };
    const boxAt = (pi, wx, wy) => {
      const p = S.pages[pi];
      for (let i = p.regions.length - 1; i >= 0; i--) {
        const [x1, y1, x2, y2] = p.regions[i].box;
        if (wx >= p.x + x1 && wx <= p.x + x2 && wy >= p.y + y1 && wy <= p.y + y2) return i;
      }
      return -1;
    };

    // 页面状态色：todo=灰 / queued=黄 / running=蓝 / done=绿 / error=红
    const STATUS = {
      idle: 'rgba(140,140,140,.85)', queued: 'rgba(214,158,46,.95)',
      running: 'rgba(37,99,235,.95)', done: 'rgba(20,140,90,.9)', error: 'rgba(200,40,40,.95)',
    };

    function draw() {
      const c = cv.value;
      if (!c || !ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      // 宽和高都要检查：只比宽度的话，窗口高度变化后位图会被纵向拉伸，
      // 鼠标下的世界坐标就会偏移（这是之前平移/缩放"不准"的根因）
      const wantW = Math.max(1, Math.round(c.clientWidth * dpr));
      const wantH = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== wantW) c.width = wantW;
      if (c.height !== wantH) c.height = wantH;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 位图尺寸必须先用整数对齐；否则 dpr 非整数时 setTransform 会带来半像素偏移，
      // 拖动时整页内容就以 0.5px 为单位「呼吸」
      ctx.clearRect(0, 0, vw(), vh());
      ctx.fillStyle = '#f5f5f5';
      ctx.fillRect(0, 0, vw(), vh());

      ctx.save();
      // 平移量取整到 1/dpr 像素：小数偏移会让每张图各自落在不同半像素上，
      // 表现为拖动时图片边缘/文字在抖。取整后拖动手感和参考实现一致（停稳、不闪）
      const dprSnap = dpr >= 1 ? dpr : 1;
      const txS = Math.round(S.tx * dprSnap) / dprSnap;
      const tyS = Math.round(S.ty * dprSnap) / dprSnap;
      ctx.translate(txS, tyS);
      ctx.scale(S.scale, S.scale);

      for (let pi = 0; pi < S.pages.length; pi++) {
        const p = S.pages[pi];
        const sx = p.x * S.scale + S.tx, sy = p.y * S.scale + S.ty;
        const sw = p.width * S.scale, sh = p.height * S.scale;
        if (sx > vw() || sy > vh() || sx + sw < 0 || sy + sh < 0) continue;
        const on = pi === S.selPage;

        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,.14)';
        ctx.shadowBlur = 16 / S.scale;
        ctx.shadowOffsetY = 3 / S.scale;
        ctx.fillStyle = '#fff';
        ctx.fillRect(p.x, p.y, p.width, p.height);
        ctx.restore();
        if (p.img?.complete) ctx.drawImage(p.img, p.x, p.y);

        if (on) {
          ctx.strokeStyle = '#111';
          ctx.lineWidth = 3 / S.scale;
          ctx.strokeRect(p.x, p.y, p.width, p.height);
        }

        if (S.scale < 0.1) continue;
        const busy = pageBusy.get('page:' + p.page);
        p.regions.forEach((r, ri) => {
          const [x1, y1, x2, y2] = r.box;
          const selected = on && (S.selBox === ri || S.selExtra.includes(ri)
            || (S.drag?.kind === 'select' && S.drag.pi === pi && S.drag.hits?.includes(ri)));
          const hovered = S.hover?.pi === pi && S.hover?.ri === ri;
          const redetect = r.source === 'redetect';
          const bx = p.x + x1, by = p.y + y1, bw = x2 - x1, bh = y2 - y1;
          const loading = pending.has(boxKey(p.page, r.box));

          // 框内识别：流光边框（参考 05）—— 边框上一段光绕着跑 + 内侧微光呼吸
          if (loading) {
            ctx.save();
            // 内侧淡淡压暗 + 微光
            ctx.fillStyle = 'rgba(6,14,24,.30)';
            ctx.fillRect(bx, by, bw, bh);
            const glowPulse = (0.5 + 0.5 * Math.sin(nowSec * (Math.PI * 2 / 2.6)));  // 2.6s 呼吸
            const inner = ctx.createRadialGradient(
              bx + bw / 2, by + bh / 2, 0,
              bx + bw / 2, by + bh / 2, Math.max(bw, bh) * 0.7);
            inner.addColorStop(0, 'rgba(0,255,200,' + (0.10 + glowPulse * 0.10) + ')');
            inner.addColorStop(1, 'rgba(0,255,200,0)');
            ctx.fillStyle = inner;
            ctx.fillRect(bx, by, bw, bh);

            // 边框底线（很淡）
            ctx.strokeStyle = 'rgba(0,255,200,.18)';
            ctx.lineWidth = 1.5 / S.scale;
            ctx.strokeRect(bx, by, bw, bh);

            // 沿边框跑的一段亮光：用 lineDash 控制一段弧长
            const perim = 2 * (bw + bh);
            const segLen = Math.min(perim * 0.34, 190 / S.scale);
            const off = -((nowSec % 2.6) / 2.6) * perim;     // 2.6s 绕一圈（示例 05）
            ctx.save();
            ctx.lineWidth = 2.4 / S.scale;
            ctx.strokeStyle = 'rgba(141,255,238,.98)';
            ctx.shadowColor = 'rgba(0,255,200,.85)';
            ctx.shadowBlur = 12 / S.scale;
            ctx.setLineDash([segLen, Math.max(1, perim - segLen)]);
            ctx.lineDashOffset = off;
            ctx.beginPath();
            ctx.rect(bx, by, bw, bh);
            ctx.stroke();
            ctx.restore();

            // 四角卡口
            ctx.strokeStyle = 'rgba(141,255,238,.9)';
            ctx.lineWidth = 3 / S.scale;
            const armL = Math.min(11 / S.scale, bw / 3, bh / 3);
            ctx.beginPath();
            ctx.moveTo(bx, by + armL); ctx.lineTo(bx, by); ctx.lineTo(bx + armL, by);
            ctx.moveTo(bx + bw - armL, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + armL);
            ctx.moveTo(bx + bw, by + bh - armL); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw - armL, by + bh);
            ctx.moveTo(bx + armL, by + bh); ctx.lineTo(bx, by + bh); ctx.lineTo(bx, by + bh - armL);
            ctx.stroke();
            ctx.restore();

            // 底部小标签（不压文字）
            const label = '识别中';
            const fs = Math.round(11 / S.scale);
            ctx.save();
            ctx.font = 600 + ' ' + fs + 'px "Microsoft YaHei", sans-serif';
            const tw = ctx.measureText(label).width;
            const padX = 7 / S.scale, ph = 18 / S.scale, dot = 5 / S.scale;
            const tagW = tw + padX * 2 + dot + 5 / S.scale;
            const lx = bx + (bw - tagW) / 2;
            const ly = by + bh - ph - 4 / S.scale;
            if (bw > tagW + 6 / S.scale && bh > ph * 2) {
              ctx.fillStyle = 'rgba(4,12,20,.86)';
              ctx.fillRect(lx, ly, tagW, ph);
              ctx.strokeStyle = 'rgba(0,255,200,.55)';
              ctx.lineWidth = 1 / S.scale;
              ctx.strokeRect(lx, ly, tagW, ph);
              const blink = 0.35 + 0.65 * Math.abs(Math.sin(nowSec * (Math.PI * 2 / 1.1)));  // 1.1s 闪烁
              ctx.fillStyle = 'rgba(0,255,200,' + blink + ')';
              ctx.beginPath();
              ctx.arc(lx + padX + dot / 2, ly + ph / 2, dot / 2, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = '#9dffe8';
              ctx.textBaseline = 'middle';
              ctx.fillText(label, lx + padX + dot + 5 / S.scale, ly + ph / 2);
            }
            ctx.restore();
            return;
          }


          if (!selected) {
            ctx.lineWidth = (hovered ? 2 : 1.5) / S.scale;
            ctx.strokeStyle = redetect ? 'rgba(20,140,90,.9)' : 'rgba(214,48,48,.9)';
            ctx.fillStyle = hovered ? 'rgba(17,17,17,.09)' : redetect ? 'rgba(20,140,90,.05)' : 'rgba(214,48,48,.04)';
            ctx.fillRect(bx, by, bw, bh);
            ctx.strokeRect(bx, by, bw, bh);
            return;
          }
          const ACCENT = '#2563eb';
          ctx.save();
          ctx.shadowColor = 'rgba(37,99,235,.95)';
          ctx.shadowBlur = 22 / S.scale;
          ctx.strokeStyle = ACCENT;
          ctx.lineWidth = 4 / S.scale;
          ctx.strokeRect(bx, by, bw, bh);
          ctx.restore();
          ctx.fillStyle = 'rgba(37,99,235,.20)';
          ctx.fillRect(bx, by, bw, bh);
          ctx.lineWidth = 2 / S.scale;
          ctx.strokeStyle = ACCENT;
          ctx.strokeRect(bx, by, bw, bh);
          ctx.save();
          ctx.setLineDash([6 / S.scale, 4 / S.scale]);
          ctx.strokeStyle = 'rgba(255,255,255,.9)';
          ctx.lineWidth = 1.4 / S.scale;
          const ins = 3 / S.scale;
          ctx.strokeRect(bx + ins, by + ins, Math.max(0, bw - ins * 2), Math.max(0, bh - ins * 2));
          ctx.restore();
          const arm = Math.min(14 / S.scale, bw / 3, bh / 3);
          ctx.strokeStyle = ACCENT;
          ctx.lineWidth = 4 / S.scale;
          ctx.beginPath();
          ctx.moveTo(bx, by + arm); ctx.lineTo(bx, by); ctx.lineTo(bx + arm, by);
          ctx.moveTo(bx + bw - arm, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + arm);
          ctx.moveTo(bx + bw, by + bh - arm); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw - arm, by + bh);
          ctx.moveTo(bx + arm, by + bh); ctx.lineTo(bx, by + bh); ctx.lineTo(bx, by + bh - arm);
          ctx.stroke();
        });

        // 整页任务：扫描线效果（参考示例 01）
        //   压暗 + 网格 + 一道亮绿扫描光自上而下 + 四角 HUD + 左下角文字
        if (busy) {
          const label = { 'detect-page': '整页找框', 'ocr-page': '整页识别',
                          'detect-region': '区域找框', 'ocr-region': '区域识别' }[busy.mode] || '处理中';
          ctx.save();

          // 剪到页面范围内，光不会溢到别页
          ctx.beginPath();
          ctx.rect(p.x, p.y, p.width, p.height);
          ctx.clip();

          // 压暗（呼吸）
          const breath = 0.34 + 0.06 * Math.sin(nowSec * (Math.PI * 2 / 3.4));   // 3.4s 呼吸
          ctx.fillStyle = `rgba(3,10,18,${breath})`;
          ctx.fillRect(p.x, p.y, p.width, p.height);

          // 网格
          const gs = 24 / S.scale;
          const gop = 0.10 + 0.06 * (0.5 + 0.5 * Math.sin(nowSec * (Math.PI * 2 / 3.2)));  // 3.2s 网格脉动
          ctx.strokeStyle = `rgba(0,255,200,${gop})`;
          ctx.lineWidth = 1 / S.scale;
          ctx.beginPath();
          for (let gx = p.x; gx <= p.x + p.width; gx += gs) {
            ctx.moveTo(gx, p.y); ctx.lineTo(gx, p.y + p.height);
          }
          for (let gy = p.y; gy <= p.y + p.height; gy += gs) {
            ctx.moveTo(p.x, gy); ctx.lineTo(p.x + p.width, gy);
          }
          ctx.stroke();

          // 扫描光：一条亮线 + 向上的拖尾，0→1 循环
          // 3.4s 扫一遍；起止点各留出光带高度，速度按屏幕像素恒定
          const beamH = 120 / S.scale;
          const prog = (nowSec % 3.4) / 3.4;
          const travel = p.height + beamH;
          const beamY = p.y - beamH + travel * prog;
          const grad = ctx.createLinearGradient(0, beamY - beamH, 0, beamY);
          grad.addColorStop(0, 'rgba(0,255,200,0)');
          grad.addColorStop(0.55, 'rgba(0,255,200,.10)');
          grad.addColorStop(1, 'rgba(0,255,200,.34)');
          ctx.fillStyle = grad;
          ctx.fillRect(p.x, Math.max(p.y, beamY - beamH), p.width,
                       Math.min(beamH, beamY - p.y));
          // 亮线
          ctx.strokeStyle = 'rgba(141,255,238,.95)';
          ctx.lineWidth = 2 / S.scale;
          ctx.shadowColor = 'rgba(0,255,200,.8)';
          ctx.shadowBlur = 16 / S.scale;
          ctx.beginPath();
          ctx.moveTo(p.x, beamY); ctx.lineTo(p.x + p.width, beamY);
          ctx.stroke();
          ctx.shadowBlur = 0;

          // 四角 HUD 卡口
          const arm = Math.min(18 / S.scale, p.width / 6, p.height / 6);
          const m = 10 / S.scale;
          ctx.strokeStyle = 'rgba(141,255,238,.9)';
          ctx.lineWidth = 2 / S.scale;
          ctx.beginPath();
          ctx.moveTo(p.x + m, p.y + m + arm); ctx.lineTo(p.x + m, p.y + m); ctx.lineTo(p.x + m + arm, p.y + m);
          ctx.moveTo(p.x + p.width - m - arm, p.y + m); ctx.lineTo(p.x + p.width - m, p.y + m);
          ctx.lineTo(p.x + p.width - m, p.y + m + arm);
          ctx.moveTo(p.x + p.width - m, p.y + p.height - m - arm);
          ctx.lineTo(p.x + p.width - m, p.y + p.height - m);
          ctx.lineTo(p.x + p.width - m - arm, p.y + p.height - m);
          ctx.moveTo(p.x + m + arm, p.y + p.height - m); ctx.lineTo(p.x + m, p.y + p.height - m);
          ctx.lineTo(p.x + m, p.y + p.height - m - arm);
          ctx.stroke();
          ctx.restore();

          // 左下角标签（在图片内，不压文字时用半透明底）
          ctx.save();
          const fs = Math.round(11 / S.scale);
          ctx.font = `600 ${fs}px "Microsoft YaHei", sans-serif`;
          const tw2 = ctx.measureText(label).width;
          const padX = 9 / S.scale, ph = 20 / S.scale, dot = 5 / S.scale;
          const tagW = tw2 + padX * 2 + dot + 6 / S.scale;
          const lx = p.x + 14 / S.scale;
          const ly = p.y + p.height - ph - 14 / S.scale;
          if (p.width > tagW + 20 / S.scale) {
            ctx.fillStyle = 'rgba(4,12,20,.82)';
            ctx.fillRect(lx, ly, tagW, ph);
            const blink = 0.35 + 0.65 * Math.abs(Math.sin(nowSec * (Math.PI * 2 / 1.1)));
            ctx.fillStyle = `rgba(0,255,200,${blink})`;
            ctx.beginPath();
            ctx.arc(lx + padX + dot / 2, ly + ph / 2, dot / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#9dffe8';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, lx + padX + dot + 6 / S.scale, ly + ph / 2);
          }
          ctx.restore();
        }

        // 区域任务（按 E 画框）：微光扫过（参考 02），只作用在这块区域
        const rb = regionBusy.get(p.page);
        if (rb && Array.isArray(rb.box)) {
          const [rx1, ry1, rx2, ry2] = rb.box;
          const bx2 = p.x + rx1, by2 = p.y + ry1;
          const bw2 = rx2 - rx1, bh2 = ry2 - ry1;

          // 区域外压暗，突出「只处理这一块」
          ctx.save();
          ctx.beginPath();
          ctx.rect(p.x, p.y, p.width, p.height);
          ctx.rect(bx2, by2, bw2, bh2);
          ctx.fillStyle = 'rgba(3,10,18,.30)';
          ctx.fill('evenodd');
          ctx.restore();

          // 区域内：柔和的暗底（呼吸）+ 斜向白光扫过
          ctx.save();
          ctx.beginPath();
          ctx.rect(bx2, by2, bw2, bh2);
          ctx.clip();
          const scrim = 0.30 + 0.10 * (0.5 + 0.5 * Math.sin(nowSec * (Math.PI * 2 / 2.6)));  // 2.6s 呼吸
          ctx.fillStyle = 'rgba(4,10,20,' + scrim + ')';
          ctx.fillRect(bx2, by2, bw2, bh2);

          // 斜向微光带：从右向左扫（2.4s 一次，示例 02）
          // 带宽按屏幕像素算，容器宽高不同也不会拉伸变形
          const phase = (nowSec % 2.4) / 2.4;
          const bandW = Math.max(120 / S.scale, Math.min(bw2 * 0.6, 260 / S.scale));
          const span = bw2 + bandW * 2;
          const cx0 = bx2 + bw2 + bandW - span * phase;
          ctx.save();
          ctx.translate(cx0, by2 + bh2 / 2);
          ctx.rotate(-0.28);
          const g3 = ctx.createLinearGradient(-bandW / 2, 0, bandW / 2, 0);
          g3.addColorStop(0, 'rgba(255,255,255,0)');
          g3.addColorStop(0.35, 'rgba(255,255,255,0.10)');
          g3.addColorStop(0.5, 'rgba(255,255,255,0.42)');
          g3.addColorStop(0.65, 'rgba(255,255,255,0.10)');
          g3.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g3;
          // 高度取「旋转后仍能盖满」的尺寸，不受框高宽比影响
          const coverH = (Math.hypot(bw2, bh2) + bandW) * 1.1;
          ctx.fillRect(-bandW / 2, -coverH, bandW, coverH * 2);
          ctx.restore();
          ctx.restore();

          // 绿色虚线框（和画框时一致）+ 四角
          ctx.save();
          ctx.strokeStyle = 'rgba(20,220,140,.95)';
          ctx.lineWidth = 2 / S.scale;
          ctx.setLineDash([9 / S.scale, 6 / S.scale]);
          ctx.strokeRect(bx2, by2, bw2, bh2);
          ctx.setLineDash([]);
          const arm2 = Math.min(12 / S.scale, bw2 / 3, bh2 / 3);
          ctx.lineWidth = 3 / S.scale;
          ctx.beginPath();
          ctx.moveTo(bx2, by2 + arm2); ctx.lineTo(bx2, by2); ctx.lineTo(bx2 + arm2, by2);
          ctx.moveTo(bx2 + bw2 - arm2, by2); ctx.lineTo(bx2 + bw2, by2); ctx.lineTo(bx2 + bw2, by2 + arm2);
          ctx.moveTo(bx2 + bw2, by2 + bh2 - arm2); ctx.lineTo(bx2 + bw2, by2 + bh2);
          ctx.lineTo(bx2 + bw2 - arm2, by2 + bh2);
          ctx.moveTo(bx2 + arm2, by2 + bh2); ctx.lineTo(bx2, by2 + bh2); ctx.lineTo(bx2, by2 + bh2 - arm2);
          ctx.stroke();

          // 顶部小标签：区域找框中
          const lbl = '区域找框中';
          const fs2 = Math.round(11 / S.scale);
          ctx.font = 600 + ' ' + fs2 + 'px "Microsoft YaHei", sans-serif';
          const tw4 = ctx.measureText(lbl).width;
          const px2 = 7 / S.scale, ph4 = 18 / S.scale, dot2 = 5 / S.scale;
          const tagW2 = tw4 + px2 * 2 + dot2 + 5 / S.scale;
          if (bw2 > tagW2 + 4 / S.scale) {
            const tx4 = bx2 + (bw2 - tagW2) / 2;
            const ty4 = Math.max(p.y + 4 / S.scale, by2 - ph4 - 5 / S.scale);
            ctx.fillStyle = 'rgba(4,20,14,.9)';
            ctx.fillRect(tx4, ty4, tagW2, ph4);
            ctx.strokeStyle = 'rgba(20,220,140,.6)';
            ctx.lineWidth = 1 / S.scale;
            ctx.strokeRect(tx4, ty4, tagW2, ph4);
            const bl = 0.35 + 0.65 * Math.abs(Math.sin(nowSec * (Math.PI * 2 / 1.1)));
            ctx.fillStyle = 'rgba(20,220,140,' + bl + ')';
            ctx.beginPath();
            ctx.arc(tx4 + px2 + dot2 / 2, ty4 + ph4 / 2, dot2 / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#8dffd6';
            ctx.textBaseline = 'middle';
            ctx.fillText(lbl, tx4 + px2 + dot2 + 5 / S.scale, ty4 + ph4 / 2);
          }
          ctx.restore();
        }
      }

      if (S.drag?.kind === 'draw') {
        const b = S.drag.rect;
        ctx.setLineDash([6 / S.scale, 4 / S.scale]);
        ctx.strokeStyle = S.drag.mode === 'detect' ? '#148c5a' : '#111';
        ctx.lineWidth = 2 / S.scale;
        ctx.fillStyle = S.drag.mode === 'detect' ? 'rgba(20,140,90,.10)' : 'rgba(17,17,17,.05)';
        ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
        ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
        ctx.setLineDash([]);
        // 画「识别框」(E) 时给出明确提示：松手后会送去后台识别
        if (S.drag.mode === 'detect') {
          const label = '松手后识别这块';
          ctx.font = `600 ${Math.round(11 / S.scale)}px "Microsoft YaHei", sans-serif`;
          const tw3 = ctx.measureText(label).width;
          const ph3 = 16 / S.scale;
          const lx = b[0];
          const ly = Math.max(b[1] - ph3 - 4 / S.scale, 0);
          ctx.fillStyle = 'rgba(20,140,90,.92)';
          ctx.fillRect(lx, ly, tw3 + 12 / S.scale, ph3);
          ctx.fillStyle = '#fff';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, lx + 6 / S.scale, ly + ph3 / 2);
        }
      }

      // 橡皮擦的笔迹：跟随轨迹画一条半透明粗线
      if (S.drag?.kind === 'erase' && S.drag.pts.length) {
        const pts = S.drag.pts;
        ctx.save();
        ctx.strokeStyle = 'rgba(214,48,48,.55)';
        ctx.lineWidth = (ERASE_R * 2) / S.scale;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
        ctx.restore();
      }

      // Shift 多选：拖出来的选框 + 每个被套住的框点亮
      if (S.drag?.kind === 'select') {
        const d = S.drag, p = S.pages[d.pi];
        if (p && d.hits?.length) {
          d.hits.forEach((ri) => {
            const r = p.regions[ri];
            if (!r) return;
            const [x1, y1, x2, y2] = r.box;
            const bx = p.x + x1, by = p.y + y1;
            const bw = x2 - x1, bh = y2 - y1;
            ctx.save();
            ctx.fillStyle = 'rgba(37,99,235,.18)';
            ctx.fillRect(bx, by, bw, bh);
            ctx.strokeStyle = '#2563eb';
            ctx.lineWidth = 2.5 / S.scale;
            ctx.strokeRect(bx, by, bw, bh);
            ctx.restore();
          });
        }
        const b = d.rect;
        ctx.save();
        ctx.setLineDash([6 / S.scale, 4 / S.scale]);
        ctx.strokeStyle = '#2563eb';
        ctx.fillStyle = 'rgba(37,99,235,.08)';
        ctx.lineWidth = 1.5 / S.scale;
        ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
        ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
        ctx.restore();

        // 松手前先在选框上方提示能选中多少个
        const label = `松手选中 ${d.hits?.length || 0} 个框`;
        ctx.font = `600 ${Math.round(11 / S.scale)}px "Microsoft YaHei", sans-serif`;
        const tw = ctx.measureText(label).width;
        const ph = 17 / S.scale;
        const lx2 = b[0];
        const ly2 = Math.max(b[1] - ph - 4 / S.scale, 0);
        ctx.fillStyle = 'rgba(37,99,235,.94)';
        ctx.fillRect(lx2, ly2, tw + 12 / S.scale, ph);
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, lx2 + 6 / S.scale, ly2 + ph / 2);
      }
      ctx.restore();

      // 页码 + 状态点（屏幕像素）
      for (let pi = 0; pi < S.pages.length; pi++) {
        const p = S.pages[pi];
        const sx = p.x * S.scale + S.tx, sy = p.y * S.scale + S.ty;
        const sw = p.width * S.scale, sh = p.height * S.scale;
        if (sx > vw() || sy > vh() || sx + sw < 0 || sy + sh < 0) continue;
        const on = pi === S.selPage;
        const ty = sy + sh + 6;
        ctx.fillStyle = STATUS[p.status] || STATUS.idle;
        ctx.beginPath();
        ctx.arc(sx + 4, ty + 8, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '600 12px Geist, "Microsoft YaHei", sans-serif';
        const label = p.page;
        ctx.fillStyle = on ? '#111' : 'rgba(0,0,0,.62)';
        ctx.fillText(label, sx + 13, ty + 12);
        ctx.font = '11px Geist, "Microsoft YaHei", sans-serif';
        ctx.fillStyle = 'rgba(0,0,0,.36)';
        ctx.fillText(`${p.regions.length} 框`, sx + 13 + ctx.measureText(label).width + 20, ty + 12);
      }
    }

    // 以屏幕点 (px,py) 为中心缩放。
    // screen = world * scale + tx  ⇒  缩放前后该世界点必须仍落在 (px,py)：
    //   tx' = px - (px - tx) * (scale'/scale)
    // 到极限时直接返回，避免 tx/ty 漂移
    const MIN_SCALE = 0.02, MAX_SCALE = 8;
    function zoomAt(px, py, k) {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, S.scale * k));
      if (next === S.scale) return;
      const r = next / S.scale;
      S.tx = px - (px - S.tx) * r;
      S.ty = py - (py - S.ty) * r;
      S.scale = next;
      draw();
    }
    function fitAll() {
      if (!S.pages.length || !S.pages.every((p) => typeof p.x === 'number')) return;
      const minX = Math.min(...S.pages.map((p) => p.x));
      const minY = Math.min(...S.pages.map((p) => p.y));
      const maxX = Math.max(...S.pages.map((p) => p.x + p.width));
      const maxY = Math.max(...S.pages.map((p) => p.y + p.height + 30));
      const k = Math.min((vw() - 80) / (maxX - minX), (vh() - 130) / (maxY - minY));
      S.scale = Math.max(0.02, k);
      S.tx = (vw() - (maxX - minX) * S.scale) / 2 - minX * S.scale;
      S.ty = (vh() - (maxY - minY) * S.scale) / 2 - minY * S.scale + 10;
      draw();
    }
    function focusTarget() {
      const pad = 56;
      let rect = null;
      if (S.selPage >= 0 && S.selBox >= 0) {
        const p = S.pages[S.selPage];
        const r = p?.regions?.[S.selBox];
        if (r) rect = { x: p.x + r.box[0], y: p.y + r.box[1], w: r.box[2] - r.box[0], h: r.box[3] - r.box[1] };
      } else if (S.selPage >= 0) {
        const p = S.pages[S.selPage];
        if (p) rect = { x: p.x, y: p.y, w: p.width, h: p.height + 30 };
      }
      if (!rect) return fitAll();
      const k = Math.min((vw() - pad * 2) / Math.max(1, rect.w), (vh() - pad * 2) / Math.max(1, rect.h));
      S.scale = Math.min(6, Math.max(0.05, k));
      S.tx = vw() / 2 - (rect.x + rect.w / 2) * S.scale;
      S.ty = vh() / 2 - (rect.y + rect.h / 2) * S.scale;
      draw();
    }

    // 指数缩放：不依赖 deltaY 的符号，触摸板/鼠标/滚轮都会得到均匀手感
    function onWheel(e) {
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= vh();
      // 触控板横向滑（pan）时 deltaY 很小甚至为 0；这类事件不该触发缩放
      if (Math.abs(dy) < 0.6 && !e.ctrlKey) return;
      if (!dy) return;
      const r = cv.value.getBoundingClientRect();
      // 指数缩放（与参考实现一致）：手感均匀，不做硬性单次限幅，
      // 否则连续滚动时前几次会被削平、看起来一顿一顿
      const speed = e.ctrlKey ? 0.0072 : 0.0018;   // 触摸板双指捏合 delta 很小
      const factor = Math.exp(-dy * speed);
      zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    }

    function onDown(e) {
      if (e.button === 1) { e.preventDefault(); startPan(e); return; }
      if (e.button !== 0) return;
      const r = cv.value.getBoundingClientRect();
      const w = toWorld(e.clientX - r.left, e.clientY - r.top);
      // Shift + 左键：框选识别框（先按住 Shift 再拖）。框选模式下不抢 Q 的绘制。
      if (e.shiftKey && (S.mode === 'pan' || S.mode === 'box')) {
        const pi = pageAt(w.x, w.y);
        const ri = pi >= 0 ? boxAt(pi, w.x, w.y) : -1;
        if (ri >= 0) { toggleBoxSelect(pi, ri); return; }
        if (pi >= 0) {
          // 同一页上再框一次时保留上一次的选择，新的框会并进去
          const samePage = S.selPage === pi;
          const base = samePage && S.selBox >= 0 ? [S.selBox, ...S.selExtra] : [];
          S.selPage = pi;
          S.drag = { kind: 'select', pi, base, start: [w.x, w.y], rect: [w.x, w.y, w.x, w.y], hits: base };
          draw();
          return;
        }
      }
      if (S.mode === 'box' || S.mode === 'detect' || S.mode === 'erase') {
        const pi = pageAt(w.x, w.y);
        if (S.mode === 'erase') {
          // 橡皮擦可以在画布任何地方起笔（包括图片外面、页间空白），
          // 线经过哪一页的框就删哪一页的，跨页也算
          if (pi >= 0) S.selPage = pi;
          S.drag = { kind: 'erase', pi, pts: [[w.x, w.y]], gone: new Map() };
          eraseAlong(S.drag, [w.x, w.y], [w.x, w.y]);
          draw();
          return;
        }
        if (pi < 0) { startPan(e); return; }
        S.selPage = pi;
        S.drag = { kind: 'draw', mode: S.mode, pi, rect: [w.x, w.y, w.x, w.y] };
        draw();
        return;
      }
      const pi = pageAt(w.x, w.y);
      if (pi >= 0) {
        const ri = boxAt(pi, w.x, w.y);
        if (ri >= 0) { selectBox(pi, ri); return; }
        S.selPage = pi; S.selBox = -1; S.selExtra = []; editText.value = '';
        draw();
      } else if (S.selPage >= 0 || S.selBox >= 0 || S.selExtra.length) {
        clearSelection();
        draw();
      }
      startPan(e);
    }
    function startPan(e) {
      // 记录「上一次的指针位置」，位移按增量累加。
      // 原来用 drag 起点的 (ox, oy) 重新算绝对位置，缩放一次后那对值就过期了，
      // 画布会被拉回旧位置再跳回来——这就是平移+缩放时画面乱闪的根因。
      S.drag = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
      cv.value.classList.add('grabbing');
    }
    function onMove(e) {
      // 别的事件源（比如已经卸载的旧实例、内嵌页面）也可能把 pointermove 冒到这里，
      // 没有画布时直接忽略，别让整页报错卡住拖拽
      if (!cv.value) return;
      const r = cv.value.getBoundingClientRect();
      const w = toWorld(e.clientX - r.left, e.clientY - r.top);
      const pi = pageAt(w.x, w.y);
      if (pi >= 0) {
        const p = S.pages[pi];
        cursor.value = `${p.page} ${Math.round(w.x - p.x)}, ${Math.round(w.y - p.y)}`;
        const ri = boxAt(pi, w.x, w.y);
        const h = ri >= 0 ? { pi, ri } : null;
        if (JSON.stringify(h) !== JSON.stringify(S.hover)) { S.hover = h; if (!S.drag) draw(); }
      } else {
        cursor.value = '—';
        if (S.hover) { S.hover = null; if (!S.drag) draw(); }
      }
      if (!S.drag) return;
      if (S.drag.kind === 'pan') {
        S.tx += e.clientX - S.drag.lastX;
        S.ty += e.clientY - S.drag.lastY;
        S.drag.lastX = e.clientX;
        S.drag.lastY = e.clientY;
        draw();
      } else if (S.drag.kind === 'draw') {
        S.drag.rect = [Math.min(S.drag.rect[0], w.x), Math.min(S.drag.rect[1], w.y),
          Math.max(S.drag.rect[0], w.x), Math.max(S.drag.rect[1], w.y)];
        draw();
      } else if (S.drag.kind === 'select') {
        const p = S.pages[S.drag.pi];
        const x1 = Math.min(S.drag.start[0], w.x), y1 = Math.min(S.drag.start[1], w.y);
        const x2 = Math.max(S.drag.start[0], w.x), y2 = Math.max(S.drag.start[1], w.y);
        S.drag.rect = [x1, y1, x2, y2];
        // 世界坐标换成页面内坐标后再判交叠：只选「大部分落在选框里」的框，避免轻碰就选
        const rx1 = x1 - p.x, ry1 = y1 - p.y, rx2 = x2 - p.x, ry2 = y2 - p.y;
        const inRect = p.regions.map((r, i) => {
          const b = r.box;
          const iw = Math.max(0, Math.min(rx2, b[2]) - Math.max(rx1, b[0]));
          const ih = Math.max(0, Math.min(ry2, b[3]) - Math.max(ry1, b[1]));
          const area = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
          return (iw * ih) / area > 0.5 ? i : -1;
        }).filter((i) => i >= 0);
        S.drag.hits = [...new Set([...(S.drag.base || []), ...inRect])];
        draw();
      } else if (S.drag.kind === 'erase') {
        const prev = S.drag.pts[S.drag.pts.length - 1];
        // 太密的点不记，省得轨迹过长
        if (Math.hypot(w.x - prev[0], w.y - prev[1]) > 1.5 / S.scale) {
          S.drag.pts.push([w.x, w.y]);
          eraseAlong(S.drag, prev, [w.x, w.y]);
          draw();
        }
      }
    }
    async function onUp() {
      if (!S.drag) return;
      const d = S.drag;
      S.drag = null;
      applyCursor();
      if (d.kind === 'erase') {
        let gone = 0;
        for (const set of d.gone.values()) gone += set.size;
        if (!gone) { draw(); return; }
        const updates = [...d.gone.entries()].map(([pi, set]) => ({
          page: S.pages[pi].page,
          regions: S.pages[pi].regions,
          sha: S.pages[pi].sha,
          boxes: [...set].map((r) => r.box),
        }));
        await applyEraseBatch(updates, gone);
        // 已经被 applyEraseBatch 写回了，别让后面的「保存」再拿旧数据覆盖
        for (const u of updates) dirty.delete(u.page);
        notify.success(`已擦掉 ${gone} 个框`);
        draw();
        return;
      }
      if (d.kind === 'select') {
        // 框选结束：选中命中的框。单选语义仍是「一个主框 + 若干附加框」，
        // 这样右侧面板、删除、编辑等老逻辑都还能用。
        const hits = d.hits || [];
        if (!hits.length) {
          S.selBox = -1; S.selExtra = []; editText.value = '';
        } else {
          S.selPage = d.pi;
          S.selBox = hits[0];
          S.selExtra = hits.slice(1);
          editText.value = S.pages[d.pi].regions[hits[0]]?.text || '';
        }
        const n = selectedCount.value;
        if (n > 1) notify.success(`已选中 ${n} 个框`);
        draw();
        revealSelectedBox();
        return;
      }
      if (d.kind !== 'draw') { draw(); return; }
      const p = S.pages[d.pi];
      const [x1, y1, x2, y2] = d.rect.map((v, i) => v - (i % 2 === 0 ? p.x : p.y));
      if (x2 - x1 < 10 || y2 - y1 < 10) { draw(); return; }

      if (d.mode === 'detect') {
        // 只对这一块区域找框：后台会真的裁图再送模型
        const box = [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)];
        // 注意：这里不要提前删本地框。识别结果回来前先只显示加载态，
        // 等后台成功并合并好数据再刷新；否则失败时会把框白白删掉。
        const prev = p.regions.length;
        // 只在画出来的这块区域里显示加载，不动整页
        regionBusy.set(p.page, { box, mode: 'detect-region' });
        draw();
        try {
          const rec = await fetch(`/api/session/${encodeURIComponent(S.session)}/job`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page: p.page, mode: 'detect-region', box }),
          }).then((x) => x.json());
          notify.success(`区域找框已入队 · ${box.join(',')}`);
          if (prev !== p.regions.length) draw();
          return rec;
        } catch {
          regionBusy.delete(p.page);
          notify.error('提交失败');
          draw();
        }
      } else {
        const box = [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)];
        p.regions.push({ id: p.regions.length, box, text: '', prob: 1, source: 'manual' });
        draw();
        await saveRegions(d.pi, 'box-add', { box, summary: `手动画框 ${box.join(',')}` });
      }
    }

    // ---------- 橡皮擦：线段与矩形相交判定 ----------
    function segIntersectsRect(a, b, r) {
      // 线段 a-b 与矩形 r（含外扩半径）是否相交
      const [x1, y1, x2, y2] = r;
      const inside = (px, py) => px >= x1 && px <= x2 && py >= y1 && py <= y2;
      if (inside(a[0], a[1]) || inside(b[0], b[1])) return true;
      const inter = (p, q, s, t) => {
        const d1 = (q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0]);
        const d2 = (q[0] - p[0]) * (t[1] - p[1]) - (q[1] - p[1]) * (t[0] - p[0]);
        const d3 = (t[0] - s[0]) * (p[1] - s[1]) - (t[1] - s[1]) * (p[0] - s[0]);
        const d4 = (t[0] - s[0]) * (q[1] - s[1]) - (t[1] - s[1]) * (q[0] - s[0]);
        return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
      };
      const corners = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
      for (let i = 0; i < 4; i++) {
        if (inter(a, b, corners[i], corners[(i + 1) % 4])) return true;
      }
      return false;
    }

    // 笔刷有粗细：把矩形外扩 ERASE_R 个屏幕像素再判相交
    function eraseAlong(d, from, to) {
      const pad = ERASE_R / S.scale;
      // 笔迹可能横跨两页，所以每页都判一遍
      for (let pi = 0; pi < S.pages.length; pi++) {
        const p = S.pages[pi];
        const pa = [from[0] - p.x, from[1] - p.y];
        const pb = [to[0] - p.x, to[1] - p.y];
        for (let i = p.regions.length - 1; i >= 0; i--) {
          const r = p.regions[i];
          const grown = [r.box[0] - pad, r.box[1] - pad, r.box[2] + pad, r.box[3] + pad];
          if (segIntersectsRect(pa, pb, grown)) {
            if (!d.gone.has(pi)) d.gone.set(pi, new Set());
            d.gone.get(pi).add(r);
            p.regions.splice(i, 1);
          }
        }
        if (d.gone.has(pi)) {
          dirty.add(p.page);
        if (pi === S.selPage) {
          if (S.selBox >= p.regions.length) { S.selBox = -1; editText.value = ''; }
          if (S.selExtra.length) S.selExtra = S.selExtra.filter((i) => i < p.regions.length);
        }
        }
      }
    }

    // 跨页擦除落盘：一次请求提交多页，只记一条历史
    async function applyEraseBatch(updates, total) {
      if (!updates.length) return;
      const r = await fetch(`/api/session/${encodeURIComponent(S.session)}/erase`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          total,
          pages: updates.map((u) => ({ page: u.page, regions: u.regions, sha: u.sha, boxes: u.boxes })),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { notify.error(j.error || '保存失败'); return; }
      for (const u of updates) {
        const p = S.pages.find((x) => x.page === u.page);
        if (p) dirty.delete(p.page);
      }
      if (sideTab.value === 'history') await loadHistory();
    }

    function onKey(e) {
      const t = e.target.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
      const k = e.key.toLowerCase();
      const hot = { q: 'box', e: 'detect', d: 'erase' }[k];
      if (hot && latch !== k) { latch = k; setMode(hot); e.preventDefault(); }
      if (e.key === 'Escape') {
        const hadSelection = S.selPage >= 0 || S.selExtra.length || S.selBox >= 0;
        latch = null; setMode('pan');
        // 先退掉框的选中，再退掉整页选中，避免一次全清
        if (hadSelection && (S.selBox >= 0 || S.selExtra.length)) {
          S.selBox = -1; S.selExtra = []; editText.value = ''; draw();
        } else if (hadSelection) {
          clearSelection(); draw();
        }
      }
      if (k === 'f') focusTarget();
      if (e.key === 'ArrowLeft') { e.preventDefault(); cycleBox(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); cycleBox(1); }
      // ↑/↓（包括关掉 NumLock 后的小键盘 8/2）：按顺序循环切换选中的框
      if (e.key === 'ArrowUp') { e.preventDefault(); stepBox(-1); }
      if (e.key === 'ArrowDown') { e.preventDefault(); stepBox(1); }
      // I / O / P：右侧面板的三个按钮。只有选中图片（以及「框内文字」需要选中框）时才生效
      if (!e.ctrlKey && !e.metaKey && !e.altKey && S.selPage >= 0) {
        if (k === 'i') { e.preventDefault(); queuePageDetect(); }
        else if (k === 'o') { e.preventDefault(); queuePageOcr(); }
        else if (k === 'p' && selectedCount.value > 0) { e.preventDefault(); queueBoxOcr(); }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedCount.value > 0) {
        e.preventDefault(); removeSelectedBoxes();
      }
    }
    function onKeyUp(e) {
      const k = e.key.toLowerCase();
      if (latch && k === latch) { latch = null; setMode('pan'); }
    }
    function onBlur() { if (latch) { latch = null; setMode('pan'); } }
    function setMode(m) {
      S.mode = m;
      applyCursor();
      draw();
    }
    function applyCursor() {
      if (!cv.value) return;
      cv.value.style.cursor = S.mode === 'pan' ? 'grab' : 'crosshair';
      // 拖拽中重设 cursor 会把 'grabbing' 覆盖掉，这里一并清掉类名
      cv.value.classList.toggle('grabbing', S.drag?.kind === 'pan');
    }

    function selectBox(pi, ri, additive = false) {
      if (additive && S.selPage === pi) {
        toggleBoxSelect(pi, ri);
        return;
      }
      S.selPage = pi; S.selBox = ri; S.selExtra = [];
      editText.value = S.pages[pi]?.regions[ri]?.text || '';
      draw();
      revealSelectedBox();
    }

    // Shift 点框：已选中的取消，没选中的加入
    function toggleBoxSelect(pi, ri) {
      if (S.selPage !== pi) { S.selPage = pi; S.selBox = -1; S.selExtra = []; }
      if (S.selBox === ri) {
        S.selBox = S.selExtra.length ? S.selExtra.shift() : -1;
        editText.value = S.selBox >= 0 ? (S.pages[pi].regions[S.selBox]?.text || '') : '';
      } else if (S.selExtra.includes(ri)) {
        S.selExtra = S.selExtra.filter((x) => x !== ri);
      } else if (S.selBox < 0) {
        S.selBox = ri;
        editText.value = S.pages[pi].regions[ri]?.text || '';
      } else {
        S.selExtra = [...S.selExtra, ri];
      }
      draw();
      revealSelectedBox();
    }

    function clearSelection() {
      S.selPage = -1; S.selBox = -1; S.selExtra = []; editText.value = '';
    }
    // 当前选中的所有框（主框 + 附加框），都解释成 {pi, ri}
    function selectedBoxes() {
      if (S.selPage < 0) return [];
      const p = S.pages[S.selPage];
      if (!p) return [];
      const idx = S.selBox >= 0 ? [S.selBox, ...S.selExtra] : [...S.selExtra];
      return [...new Set(idx)].filter((i) => p.regions[i]).map((ri) => ({ pi: S.selPage, ri, box: p.regions[ri] }));
    }
    const selectedCount = computed(() => selectedBoxes().length);
    const selectedText = computed(() => {
      const n = selectedCount.value;
      return n > 1 ? `${n} 个框` : n === 1 ? '1 个框' : '';
    });
    // 缩略图上把附加选中的框也画出来（淡蓝虚线），主框仍是实线
    const thumbExtraStyles = computed(() => {
      const p = curPage.value;
      if (!p) return [];
      return S.selExtra.filter((i) => p.regions[i]).map((i) => {
        const [x1, y1, x2, y2] = p.regions[i].box;
        return {
          position: 'absolute', left: `${(x1 / p.width) * 100}%`, top: `${(y1 / p.height) * 100}%`,
          width: `${((x2 - x1) / p.width) * 100}%`, height: `${((y2 - y1) / p.height) * 100}%`,
          border: '2px dashed #2563eb', background: 'rgba(37,99,235,.10)', pointerEvents: 'none',
          boxSizing: 'border-box',
        };
      });
    });
    // 后端回推新框后，索引可能越界：把已经消失的附加框清掉
    function reconcileSelection() {
      if (S.selPage < 0) { S.selExtra = []; return; }
      const p = S.pages[S.selPage];
      if (!p) { clearSelection(); return; }
      if (S.selBox >= p.regions.length) { S.selBox = -1; editText.value = ''; }
      S.selExtra = [...new Set(S.selExtra)].filter((i) => i < p.regions.length && i !== S.selBox);
    }
    // 后端重排/替换框之后索引会变，用坐标把原来的选择对应回来
    const boxMatchKey = (b) => b.map((v) => Math.round(Number(v))).join(',');
    function remapSelection(p, boxes) {
      const keys = p.regions.map((r) => boxMatchKey(r.box));
      const idx = boxes.map((b) => keys.indexOf(boxMatchKey(b))).filter((i) => i >= 0);
      if (!idx.length) { S.selBox = -1; S.selExtra = []; editText.value = ''; return; }
      S.selBox = idx[0];
      S.selExtra = [...new Set(idx.slice(1))].filter((i) => i !== S.selBox);
      editText.value = p.regions[idx[0]]?.text || '';
    }

    // 把选中的框滚到区域列表的可视范围里；顶部按钮和底部编辑框是固定的，
    // 所以这里只滚中间那段，并且要给吸顶的「区域 / 清空」让出高度
    function revealSelectedBox() {
      if (sideTab.value !== 'detail') return;
      nextTick(() => {
        const el = detailScroll.value;
        if (!el || S.selBox < 0) return;
        const row = el.querySelector(`[data-box-index="${S.selBox}"]`);
        if (!row) return;
        const er = el.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        const head = el.querySelector('.box-head.sticky');
        const pad = 8;
        const topLimit = er.top + (head ? head.offsetHeight : 0) + pad;
        const bottomLimit = er.bottom - pad;
        if (rr.top >= topLimit && rr.bottom <= bottomLimit) return;
        el.scrollTo({ top: el.scrollTop + (rr.top - topLimit), behavior: 'smooth' });
      });
    }
    // 从别的 tab 切回区域时，也把当前选中的框带出来
    watch(() => sideTab.value, (v) => { if (v === 'detail') revealSelectedBox(); });

    const curPage = computed(() => (S.selPage >= 0 ? S.pages[S.selPage] : null));
    const curBox = computed(() => (curPage.value && S.selBox >= 0 ? curPage.value.regions[S.selBox] : null));
    const fillRate = computed(() => {
      const p = curPage.value;
      if (!p?.regions.length) return 0;
      return Math.round((p.regions.filter((r) => (r.text || '').trim()).length / p.regions.length) * 100);
    });
    const overlapGroup = computed(() => {
      const p = curPage.value;
      if (!p || S.selBox < 0) return [];
      const a = p.regions[S.selBox]?.box;
      if (!a) return [];
      const area = (b) => Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
      const hit = [S.selBox];
      p.regions.forEach((r, i) => {
        if (i === S.selBox) return;
        const b = r.box;
        const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
        const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
        const inter = iw * ih;
        if (inter > 0 && inter / Math.min(area(a), area(b)) > 0.25) hit.push(i);
      });
      return hit.sort((x, y) => x - y);
    });
    function cycleBox(dir) {
      const list = overlapGroup.value.length ? overlapGroup.value : (curPage.value?.regions || []).map((_, i) => i);
      if (!list.length) return;
      const at = Math.max(0, list.indexOf(S.selBox));
      selectBox(S.selPage, list[(at + dir + list.length) % list.length]);
    }
    // 小键盘 ↑/↓ 或 ↑/↓：按列表顺序在所有框里循环切换
    function stepBox(dir) {
      const p = curPage.value;
      if (!p || !p.regions.length) return;
      const n = p.regions.length;
      const next = S.selBox < 0 ? (dir > 0 ? 0 : n - 1) : (S.selBox + dir + n) % n;
      selectBox(S.selPage, next);
    }
    // 按索引直接选中：越界或不是数字就不动
    function jumpToIndex(raw) {
      const v = String(raw ?? '').trim().replace(/^#/, '');
      if (!v || !/^\d+$/.test(v)) return;
      const p = curPage.value;
      if (!p) return;
      const i = Number(v);
      if (i < 0 || i >= p.regions.length) {
        notify.warning('这页只有 ' + p.regions.length + ' 个框（编号 0 - ' + (p.regions.length - 1) + '）');
        return;
      }
      selectBox(S.selPage, i);
    }
    const thumbBoxStyle = computed(() => {
      const p = curPage.value, b = curBox.value;
      if (!p || !b) return {};
      const [x1, y1, x2, y2] = b.box;
      return {
        position: 'absolute', left: `${(x1 / p.width) * 100}%`, top: `${(y1 / p.height) * 100}%`,
        width: `${((x2 - x1) / p.width) * 100}%`, height: `${((y2 - y1) / p.height) * 100}%`,
        border: '2px solid #2563eb', background: 'rgba(37,99,235,.18)', pointerEvents: 'none',
      };
    });

    // ---------- 数据 ----------
    async function loadSessions() {
      S.sessions = (await (await fetch('/api/sessions')).json()).sessions;
      // 地址栏 ?s=<文件夹名> 决定打开哪个画布：刷新、分享链接都能回到同一页
      const want = new URLSearchParams(window.location.search).get('s');
      if (want && S.sessions.includes(want) && want !== S.session) {
        await switchSession(want);
        return;
      }
      if (!S.session && S.sessions.length) await switchSession(S.sessions[0]);
    }
    async function switchSession(name) {
      // kit-select 点「清除」会给出空值，空值不切画布（否则会请求 /api/session/）
      if (!name) return;
      S.session = name;
      // 把当前画布写回地址栏，刷新后还停在这一页
      const u = new URL(window.location.href);
      if (u.searchParams.get('s') !== name) {
        u.searchParams.set('s', name);
        // 注意用 window.history：本组件里 history 是「操作历史」数组，会遮蔽浏览器对象
        window.history.replaceState(null, '', u.href);
      }
      const d = await (await fetch(`/api/session/${encodeURIComponent(name)}`)).json();
      S.pages = (d.pages || []).map((p) => ({ ...p, img: null }));
      clearSelection();
      dirty.clear();
      layout();
      fitAll();
      for (const p of S.pages) {
        const im = new Image();
        im.onload = draw;
        im.src = p.image;
        p.img = im;
      }
      await loadHistory();
    }
    async function createSession() {
      const name = newName.value.trim();
      if (!name) return;
      await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      showNew.value = false;
      newName.value = '';
      await loadSessions();
      await switchSession(name);
      notify.success('画布已创建');
    }
    async function upload(files) {
      if (!files?.length) return;
      busy.value = true;
      const payload = [];
      for (const f of files) {
        const buf = await f.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        payload.push({ name: f.name, data: `data:${f.type};base64,${b64}` });
      }
      const r = await fetch(`/api/session/${encodeURIComponent(S.session)}/upload`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: payload }),
      });
      const j = await r.json();
      busy.value = false;
      notify.success(`已上传 ${j.saved?.length || 0} 张`);
      await switchSession(S.session);
    }
    async function savePage() {
      // 保存所有有改动的页：橡皮擦的线可能扫过好几页，只存当前页会把别的页写回旧数据
      const targets = dirty.size
        ? S.pages.filter((p) => dirty.has(p.page))
        : (curPage.value ? [curPage.value] : []);
      if (!targets.length) return;
      let ok = 0, conflict = 0;
      for (const p of targets) {
        const r = await fetch(`/api/session/${encodeURIComponent(S.session)}/page/${encodeURIComponent(p.page)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ regions: p.regions, sha: p.sha }),
        });
        if (r.status === 409) {
          conflict++;
          const j = await r.json().catch(() => ({}));
          notify.error(j.error || `${p.page} 保存被拒绝`);
          continue;
        }
        dirty.delete(p.page);
        ok++;
      }
      if (ok) notify.success(`已保存 ${ok} 页`);
      if (conflict) notify.warning(`${conflict} 页有冲突，请刷新后再改`);
    }

    // 改完框以后保存，并把这次改动记进历史（带上删除的框，方便回溯 / 撤销参考）
    async function saveRegions(pi, op, extra = {}) {
      const p = S.pages[pi];
      if (!p) return null;
      const r = await fetch(`/api/session/${encodeURIComponent(S.session)}/page/${encodeURIComponent(p.page)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          regions: p.regions, op, by: 'ui', sha: p.sha,
          summary: extra.summary, before: extra.before ?? null, after: extra.after ?? null,
          box: extra.box ?? null, boxes: extra.boxes ?? null,
        }),
      });
      if (r.status === 409) {
        const j = await r.json().catch(() => ({}));
        notify.error(j.error || '保存被拒绝，请刷新页面');
        return null;
      }
      dirty.delete(p.page);
      const j = await r.json().catch(() => ({}));
      if (sideTab.value === 'history') await loadHistory();
      return j;
    }
    async function removeBox(pi, ri) {
      const p = S.pages[pi];
      const removed = p.regions[ri];
      if (!removed) return;
      p.regions.splice(ri, 1);
      S.selBox = -1; S.selExtra = []; editText.value = '';
      draw();
      await saveRegions(pi, 'box-del',
        { box: removed.box, boxes: [removed.box], summary: `删除框 #${ri}` });
    }

    // 多选删除：一条请求保存一次，历史里只记一条
    async function removeSelectedBoxes() {
      const sel = selectedBoxes();
      if (!sel.length) return;
      const pi = sel[0].pi;
      const p = S.pages[pi];
      const idx = [...new Set(sel.map((x) => x.ri))].sort((a, b) => b - a);
      if (idx.length === 1) { await removeBox(pi, idx[0]); return; }
      const boxes = idx.map((i) => p.regions[i]?.box).filter(Boolean);
      const ok = await confirmBox({
        title: `删除 ${boxes.length} 个框`,
        message: `确认删掉选中的 ${boxes.length} 个识别框？`,
        type: 'danger', confirmText: '删除', cancelText: '取消',
      });
      if (!ok) return;
      for (const i of idx) p.regions.splice(i, 1);
      S.selBox = -1; S.selExtra = []; editText.value = '';
      draw();
      await saveRegions(pi, 'box-del', { boxes, summary: `删除 ${boxes.length} 个框` });
      notify.success(`已删除 ${boxes.length} 个框`);
    }
    // 区域 tab 里清空本页所有框
    async function clearBoxes() {
      const p = curPage.value;
      if (!p || !p.regions.length) return;
      const ok = await confirmBox({
        title: '清空本页框', message: `确认删掉「${p.page}」里的 ${p.regions.length} 个框？`,
        type: 'danger', confirmText: '清空', cancelText: '取消',
      });
      if (!ok) return;
      const n = p.regions.length;
      const gone = p.regions.map((r) => r.box);
      p.regions = [];
      S.selBox = -1; S.selExtra = []; editText.value = '';
      draw();
      await saveRegions(S.pages.indexOf(p), 'box-clear',
        { summary: `清空本页框：${n} 个`, count: n, boxes: gone });
      notify.success(`已清空 ${n} 个框`);
    }
    async function applyText() {
      if (S.selBox < 0) return;
      curPage.value.regions[S.selBox].text = editText.value;
      notify.success('已更新');
      await savePage();
      draw();
    }
    async function queueJob(page, mode = 'ocr-page', extra = {}) {
      // 区域任务只在那块区域显示；整页任务才给整页遮罩
      const isRegionJob = mode === 'detect-region' || mode === 'ocr-region';
      if (isRegionJob && extra.box) regionBusy.set(page, { box: extra.box, mode });
      else pageBusy.set('page:' + page, { mode });
      draw();
      const r = await fetch(`/api/session/${encodeURIComponent(S.session)}/job`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, mode, ...extra }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        if (isRegionJob) regionBusy.delete(page); else pageBusy.delete('page:' + page);
        notify.error(j.error || '提交失败');
        draw();
        return j;
      }
      notify.success('已加入队列');
      return j;
    }

    // 框内文字：识别当前选中的所有框（Shift 多选后一次提交）
    async function queueBoxOcr() {
      const p = curPage.value;
      const sel = selectedBoxes();
      if (!p || !sel.length) return;
      const boxes = sel.map((x) => x.box.box);
      const keys = boxes.map((b) => boxKey(p.page, b));
      // 立刻给这些框打上加载标记：画布上转圈、右侧列表也转圈
      keys.forEach((k) => pending.set(k, 'local'));
      draw();
      try {
        const r = await fetch(`/api/session/${encodeURIComponent(S.session)}/job`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page: p.page, mode: 'ocr-boxes', boxes }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) {
          keys.forEach((k) => pending.delete(k));
          notify.error(j.error || '提交失败');
          draw();
          return;
        }
        if (j.id) keys.forEach((k) => pending.set(k, j.id));
        notify.success(boxes.length > 1 ? `已加入队列：识别 ${boxes.length} 个框` : '已加入队列：识别选中框');
        draw();
      } catch {
        keys.forEach((k) => pending.delete(k));
        notify.error('提交失败');
        draw();
      }
    }

    // 快捷键 I / O 只对「当前选中页」生效，所以包一层
    const queuePageDetect = () => { if (curPage.value) return queueJob(curPage.value.page, 'detect-page'); };
    const queuePageOcr = () => {
      const p = curPage.value;
      if (!p || !p.regions.length) { notify.warning('这页还没有框，先整页找框（I）'); return; }
      return queueJob(p.page, 'ocr-page');
    };

    async function removeOp(id) {
      const r = await fetch(`/api/session/${encodeURIComponent(S.session)}/history/${id}`, { method: 'DELETE' });
      if (!r.ok) { notify.error('删除失败'); return; }
      openOps.delete(id);
      notify.success('已删除');
      await loadHistory();
    }

    async function clearHistory() {
      const ok = await confirmBox({
        title: '清空历史', message: `确认删除《${S.session}》的全部历史记录和图片？`,
        type: 'danger', confirmText: '清空', cancelText: '取消',
      });
      if (!ok) return;
      const r = await fetch(`/api/session/${encodeURIComponent(S.session)}/history`, { method: 'DELETE' });
      const j = await r.json();
      notify.success(`已清空 ${j.removed || 0} 条`);
      openOps.clear();
      await loadHistory();
    }
    async function queueAll(mode = 'ocr') {
      // 所有页先亮起加载态，SSE 回来的任务会接上
      const m = mode === 'detect' ? 'detect-page' : 'ocr-page';
      for (const pg of S.pages) pageBusy.set('page:' + pg.page, { mode: m });
      draw();
      const r = await fetch(`/api/session/${encodeURIComponent(S.session)}/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pages: S.pages.map((p) => p.page), mode }),
      });
      if (!r.ok) {
        for (const pg of S.pages) pageBusy.delete('page:' + pg.page);
        notify.error('提交失败');
        draw();
        return;
      }
      notify.success(`已加入 ${S.pages.length} 个任务`);
    }
    async function loadHistory() {
      const r = await fetch(`/api/session/${encodeURIComponent(S.session)}/history`);
      history.value = (await r.json()).ops || [];
      await nextTick();
      drawManualCards();
    }

    // 历史还原：把这条记录当时的框数据写回页面（不动原图，所以不需要额外存图）
    const restoring = ref('');
    async function restoreOp(op) {
      if (!op?.id) return;
      restoring.value = op.id;
      try {
        const r = await fetch(`/api/session/${encodeURIComponent(S.session)}/history/${encodeURIComponent(op.id)}/restore`,
          { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { notify.error(j.error || '还原失败'); return; }
        notify.success(`已还原到这一步：${j.count} 个框`);
        await refreshAll();
        await loadHistory();
      } finally {
        restoring.value = '';
      }
    }

    // 手动改框的历史不存图片：用页面原图 + 当时的框坐标现场画出来
    function drawManualCards() {
      const list = document.querySelectorAll('canvas.op-canvas[data-opid]');
      for (const cvEl of list) {
        const op = history.value.find((o) => o.id === cvEl.dataset.opid);
        if (!op || !op.pageUrl) continue;
        const img = new Image();
        img.onload = () => {
          const maxW = 300;
          const k = Math.min(1, maxW / img.naturalWidth);
          cvEl.width = Math.round(img.naturalWidth * k);
          cvEl.height = Math.round(img.naturalHeight * k);
          // index.html 有一条全局 `canvas { position:absolute; width:100%; height:100% }`
          // 是给画布主区域用的。这里必须覆盖掉，否则历史缩略图会被拉成面板高度。
          cvEl.style.position = 'static';
          cvEl.style.inset = 'auto';
          cvEl.style.width = '100%';
          cvEl.style.height = 'auto';
          cvEl.style.maxWidth = '320px';
          cvEl.style.touchAction = 'auto';
          const ctx = cvEl.getContext('2d');
          ctx.drawImage(img, 0, 0, cvEl.width, cvEl.height);
          // 删掉的框画红、补上的框画绿；橡皮擦可能一次删多个
          const boxes = [];
          const add = op.kind === 'box-add';
          const color = add ? '#148c5a' : '#c0392b';
          if (op.data?.box) boxes.push(op.data.box);
          for (const b of op.data?.boxes || []) boxes.push(b);
          for (const pg of op.data?.pages || []) {
            if (pg.page !== op.page && op.page) continue;
            for (const b of pg.boxes || []) boxes.push(b);
          }
          const lw = Math.max(1.5, cvEl.width / 220);
          const seen = new Set();
          for (const b of boxes) {
            if (!Array.isArray(b) || b.length < 4) continue;
            const key = b.map((v) => Math.round(Number(v))).join(',');
            if (seen.has(key)) continue;
            seen.add(key);
            const x = b[0] * k, y = b[1] * k;
            const w = Math.max(1, (b[2] - b[0]) * k), h = Math.max(1, (b[3] - b[1]) * k);
            ctx.fillStyle = add ? 'rgba(20,140,90,.16)' : 'rgba(192,57,43,.16)';
            ctx.fillRect(x, y, w, h);
            ctx.strokeStyle = color;
            ctx.lineWidth = lw;
            ctx.strokeRect(x, y, w, h);
          }
          // 全屏预览要看到「带框的那张图」：直接把画好的 canvas 转成图片，
          // 不能再用原始页面图，否则预览里一个框都没有。
          cvEl.onclick = () => previewImage(cvEl.toDataURL('image/png'),
            `${op.page || ''} · ${op.summary || '改框记录'}`);
        };
        img.src = op.pageUrl;
      }
    }
    const filteredHistory = computed(() => {
      if (histFilter.value === 'all') return history.value;
      if (histFilter.value === 'edit') return history.value.filter((o) => String(o.kind).startsWith('box-'));
      // 音频历史：声纹 + 对话音频都归到这一栏，和识别记录分开展示
      if (histFilter.value === 'audio') return history.value.filter((o) => String(o.kind).startsWith('audio-'));
      if (histFilter.value === 'region') {
        return history.value.filter((o) => o.data?.scope === 'region' || o.data?.scope === 'box');
      }
      return history.value.filter((o) => o.kind === histFilter.value);
    });

    function onToggle(id, e) {
      if (e.target.open) openOps.add(id); else openOps.delete(id);
      if (e.target.open) nextTick().then(drawManualCards);
    }

    // 卡片里直接展示识别出的文字（框内识别 / 区域识别 / 整页识别都适用）
    function opTexts(o) {
      const d = o?.data || {};
      // AI 读图校验的 regions 只是「当时送给模型的框数据」，正文已在回答里判断过，不再重复铺一遍
      if (d.scope === 'view') return [];
      const out = [];
      for (const b of d.boxes || []) {
        const t = (b?.text || '').trim();
        if (t) out.push(t);
      }
      if (out.length) return out;
      for (const r of d.regions || []) {
        const t = (r?.text || '').trim();
        if (t) out.push(t);
      }
      return out;
    }
    function showPreview(p) {
      preview.value = p;
      previewTitle.value = p.title || '预览';
      previewOpen.value = true;
    }
    const previewImage = (url, title = '') => showPreview({ url, title });
    const previewJson = (o) => showPreview({ json: o.data, title: `${o.page} · ${o.summary}` });

    // 任务 → 历史：切到历史 tab 并自动展开对应卡片
    async function jumpToHistory(job) {
      if (!job?.result?.opId) return;
      sideTab.value = 'history';
      await loadHistory();
      histFilter.value = 'all';
      openOps.add(job.result.opId);
      await nextTick();
      const el = document.querySelector(`details.op-card[data-opid="${job.result.opId}"]`)
        || [...document.querySelectorAll('details.op-card')].find((d) => d.textContent.includes(job.page));
      if (el) {
        el.open = true;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1200);
      }
    }

    const jobStat = computed(() => {
      const last = jobs.value.slice(-80);
      return {
        queued: last.filter((j) => j.status === 'queued').length,
        running: last.filter((j) => j.status === 'running').length,
        paused: last.filter((j) => j.status === 'paused').length,
        done: last.filter((j) => j.status === 'done').length,
        error: last.filter((j) => j.status === 'error').length,
      };
    });

    // 任务列表：运行中 → 排队 → 暂停 → 其他，新的在前
    const RANK = { running: 0, queued: 1, paused: 2, error: 3, done: 4 };
    const sortedJobs = computed(() => [...jobs.value]
      .sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || (b.ts < a.ts ? -1 : 1)));
    const activeJobs = computed(() => jobs.value.filter((j) => ['queued', 'running', 'paused'].includes(j.status)));

    async function jobAction(id, act) {
      const base = act === 'remove' ? 'DELETE' : 'POST';
      const url = act === 'remove' ? `/api/jobs/${id}` : `/api/jobs/${id}/${act}`;
      const r = await fetch(url, { method: base });
      const j = await r.json();
      if (!r.ok) notify.error(j.error || '操作失败');
      else if (act === 'pause') notify.success('已暂停');
      else if (act === 'resume') notify.success('已恢复');
      else notify.success('已删除');
      await loadJobs();
    }
    const pauseJob = (id) => jobAction(id, 'pause');
    const resumeJob = (id) => jobAction(id, 'resume');
    const removeJob = (id) => jobAction(id, 'remove');

    async function pauseAll() {
      const list = jobs.value.filter((j) => j.status === 'queued');
      for (const j of list) await fetch(`/api/jobs/${j.id}/pause`, { method: 'POST' });
      notify.success(`已暂停 ${list.length} 个`);
      await loadJobs();
    }
    async function resumeAll() {
      const list = jobs.value.filter((j) => j.status === 'paused');
      for (const j of list) await fetch(`/api/jobs/${j.id}/resume`, { method: 'POST' });
      notify.success(`已恢复 ${list.length} 个`);
      await loadJobs();
    }
    async function clearFinished() {
      const list = jobs.value.filter((j) => ['done', 'error'].includes(j.status));
      for (const j of list) await fetch(`/api/jobs/${j.id}`, { method: 'DELETE' });
      notify.success(`已清理 ${list.length} 条`);
      await loadJobs();
    }

    function applyJob(j) {
      const i = jobs.value.findIndex((x) => x.id === j.id);
      if (i >= 0) jobs.value[i] = j; else jobs.value.push(j);
      const p = S.pages.find((x) => x.page === j.page);
      if (p) p.status = j.status;

      // 队列状态同步到「框级」和「页级」加载标记
      const finish = j.status === 'done' || j.status === 'error';
      if (j.mode === 'ocr-boxes' && Array.isArray(j.boxes)) {
        for (const b of j.boxes) {
          const k = boxKey(j.page, b);
          if (finish) pending.delete(k); else pending.set(k, j.id);
        }
      } else if (j.mode === 'ocr-region' && j.box) {
        // 区域识别：交给框级标记（那个框转圈），不整页遮罩
        const k = boxKey(j.page, j.box);
        if (finish) { pending.delete(k); regionBusy.delete(j.page); }
        else pending.set(k, j.id);
      } else if (j.mode === 'detect-region' && j.box) {
        // 区域找框：只在那块区域显示
        if (finish) regionBusy.delete(j.page);
        else regionBusy.set(j.page, { box: j.box, mode: 'detect-region' });
      } else if (j.mode) {
        // 页级任务：整页找框 / 整页识别 / 区域找框 / 区域识别
        const k = 'page:' + j.page;
        if (finish) pageBusy.delete(k); else pageBusy.set(k, { mode: j.mode, status: j.status });
      }
      if (finish) draw();

      if (j.status === 'done') {
        const i2 = S.pages.findIndex((x) => x.page === j.page);
        if (i2 >= 0) refreshPage(i2);
      }
      draw();
    }
    async function refreshPage(idx) {
      const p = S.pages[idx];
      const keep = S.selPage === idx ? selectedBoxes().map((x) => x.box.box) : [];
      const d = await (await fetch(`/api/session/${encodeURIComponent(S.session)}`)).json();
      const np = (d.pages || []).find((x) => x.page === p.page);
      if (!np) return;
      p.regions = np.regions; p.status = np.status;
      if (keep.length) remapSelection(p, keep); else reconcileSelection();
      if (sideTab.value === 'history') loadHistory();
      draw();
    }

    // ---------- SSE ----------
    function connect() {
      const es = new EventSource('/events');
      es.addEventListener('hello', () => { sseOn.value = true; });
      es.addEventListener('job', (e) => applyJob(JSON.parse(e.data)));
      es.addEventListener('pages', (e) => {
        const d = JSON.parse(e.data);
        if (d.session !== S.session) return;
        refreshAll();
      });
      es.addEventListener('job-removed', (e) => {
        const { id } = JSON.parse(e.data);
        jobs.value = jobs.value.filter((j) => j.id !== id);
      });
      es.addEventListener('op', (e) => {
        const d = JSON.parse(e.data);
        if (d.session === S.session && sideTab.value === 'history') loadHistory();
      });
      es.addEventListener('op-removed', (e) => {
        const d = JSON.parse(e.data);
        if (d.session === S.session) {
          history.value = history.value.filter((o) => o.id !== d.id);
          if (sideTab.value === 'history') loadHistory();
        }
      });
      es.addEventListener('op-cleared', (e) => {
        const d = JSON.parse(e.data);
        if (d.session === S.session) { history.value = []; openOps.clear(); }
      });
      es.onerror = () => { sseOn.value = false; };
    }
    async function refreshAll() {
      const keepSel = selectedBoxes().map((x) => x.box.box);
      const keepPi = S.selPage;
      const d = await (await fetch(`/api/session/${encodeURIComponent(S.session)}`)).json();
      const map = new Map((d.pages || []).map((p) => [p.page, p]));
      S.pages = S.pages.map((p) => {
        const np = map.get(p.page);
        if (!np) return p;
        p.regions = np.regions; p.status = np.status;
        return p;
      });
      if (keepSel.length && keepPi >= 0 && S.pages[keepPi]) remapSelection(S.pages[keepPi], keepSel);
      else reconcileSelection();
      draw();
    }
    async function loadJobs() {
      const d = await (await fetch('/api/jobs')).json();
      jobs.value = d.jobs || [];
      syncBusy(d.jobs || []);
    }

    // 用后台真实任务列表重建加载标记：避免界面上的转圈卡在错误状态
    function syncBusy(list) {
      const live = list.filter((j) => j.status === 'queued' || j.status === 'running');
      const boxWanted = new Map();
      const pageWanted = new Map();
      const regionWanted = new Map();
      for (const j of live) {
        if (j.mode === 'ocr-boxes' && Array.isArray(j.boxes)) {
          for (const b of j.boxes) boxWanted.set(boxKey(j.page, b), j.id);
        } else if (j.mode === 'ocr-region' && j.box) {
          boxWanted.set(boxKey(j.page, j.box), j.id);
        } else if (j.mode === 'detect-region' && j.box) {
          regionWanted.set(j.page, { box: j.box, mode: 'detect-region' });
        } else if (j.mode) {
          pageWanted.set('page:' + j.page, { mode: j.mode, status: j.status });
        }
      }
      // 只清掉「不是本地刚提交」的过期项
      for (const k of [...pending.keys()]) {
        if (pending.get(k) === 'local') continue;
        if (!boxWanted.has(k)) pending.delete(k);
      }
      for (const [k, v] of boxWanted) pending.set(k, v);
      for (const [k] of [...pageBusy.keys()]) if (!pageWanted.has(k)) pageBusy.delete(k);
      for (const [k, v] of pageWanted) pageBusy.set(k, v);
      for (const [k] of [...regionBusy.keys()]) if (!regionWanted.has(k)) regionBusy.delete(k);
      for (const [k, v] of regionWanted) regionBusy.set(k, v);
      draw();
    }

    function fmtTime(ts) {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    }

    onMounted(async () => {
      ctx = cv.value.getContext('2d');
      window.__APP = { get S() { return S; }, get sideTab() { return sideTab.value; },
        get jobs() { return jobs.value; }, get history() { return history.value; },
        get overlapGroup() { return overlapGroup.value; }, get thumbBoxStyle() { return thumbBoxStyle.value; },
        get selectedCount() { return selectedCount.value; },
        get cvEl() { return cv.value; },
        fitAll, focusTarget, draw, queueJob, queueAll, switchSession, previewImage, previewJson,
        setMode, selectBox, clearBoxes, queueBoxOcr, savePage, clearHistory, removeBox,
        isPending, pageIsBusy, pageBusyMode,
        get pendingSize() { return pending.size; }, get pageBusySize() { return pageBusy.size; },
        get regionBusySize() { return regionBusy.size; },
        debugAnim: () => ({ nowSec: +nowSec.toFixed(2),
                            scanProg: +((nowSec % 3.4) / 3.4).toFixed(3),
                            shineProg: +((nowSec % 2.4) / 2.4).toFixed(3),
                            glowProg: +((nowSec % 2.6) / 2.6).toFixed(3) }) };
      await loadSessions();
      await loadJobs();
      connect();
      cv.value.addEventListener('wheel', onWheel, { passive: false });
      // 用 pointer 事件 + 指针捕获：拖出画布外平移也不会断、不会丢 mouseup
      cv.value.addEventListener('pointerdown', (e) => {
        try { cv.value.setPointerCapture(e.pointerId); } catch {}
        onDown(e);
      });
      cv.value.addEventListener('pointermove', (e) => onMove(e));
      cv.value.addEventListener('pointerup', () => onUp());
      cv.value.addEventListener('pointercancel', () => onUp());
      cv.value.addEventListener('contextmenu', (e) => e.preventDefault());
      // 兜底：指针捕获不支持时，靠 document 上的事件收尾
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      window.addEventListener('keydown', onKey);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);
      // 尺寸变化时 canvas 的 CSS 尺寸也变了，必须重画以同步位图
      window.addEventListener('resize', () => draw());
      if (window.ResizeObserver) {
        new ResizeObserver(() => draw()).observe(cv.value);
      }
      setMode('pan');

      // 有任务时才跑动画；相位按真实秒数算，容器多大速度都一样
      let last = 0;
      const tick = (ts) => {
        requestAnimationFrame(tick);
        const active = pending.size > 0 || pageBusy.size > 0 || regionBusy.size > 0;
        if (!active) { animT0 = 0; last = ts; return; }
        if (!animT0) animT0 = ts;
        nowSec = (ts - animT0) / 1000;
        if (ts - last < 33) return;       // ~30fps，够顺滑也不费电
        last = ts;
        draw();
      };
      requestAnimationFrame(tick);
    });

    return { cv, detailScroll, S, sseOn, cursor, sideTab, editText, busy, jobs, history, histFilter,
      selectedCount, thumbExtraStyles, removeSelectedBoxes,
      ICON, MODE_LABEL, isPending, pageIsBusy, pageBusyMode,
      uploadRef, newName, showNew, sessionOptions, curPage, curBox, fillRate, thumbBoxStyle, overlapGroup,
      filteredHistory, jobStat, fmtTime,
      fitAll, setMode, applyText, removeBox, savePage, cycleBox, selectBox, queueBoxOcr, removeOp, clearHistory,
      stepBox, jumpToIndex,
      clearBoxes,
      createSession, upload, switchSession, queueJob, queueAll, loadHistory,
      sortedJobs, activeJobs, pauseJob, resumeJob, removeJob, pauseAll, resumeAll, clearFinished, loadJobs,
      openOps, preview, previewOpen, previewTitle, previewImage, previewJson, onToggle, jumpToHistory,
      restoring, restoreOp,
      toolDialog, openToolDialog,
      opTexts };
  },
}).component('lightbox', window.Lightbox).use(window.UIKit).mount('#app');
