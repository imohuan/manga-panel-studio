/* 右侧面板拖动改宽（独立脚本）
 * 只做一件事：在画布和面板之间放一条 8px 的拖拽条，用 CSS 变量 --panel-w 控制面板宽度。
 * 单独放一个文件，避免和 canvas.js / panel.html 的改动互相覆盖。
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'canvas.panelWidth';
  var DEFAULT_W = 336;
  var MIN_W = 280;
  var MAX_CAP = 720;
  var MAX_RATIO = 0.6;

  var current = DEFAULT_W;

  function mainEl() {
    return document.querySelector('.main');
  }

  function panelEl() {
    var m = mainEl();
    return m ? m.querySelector('aside.panel') : null;
  }

  /* 最大宽度：不超过 720px，也不超过窗口的 60%；再给画布留 120px，别把画布压没 */
  function maxWidth() {
    var m = mainEl();
    var total = m ? m.getBoundingClientRect().width : window.innerWidth;
    var byRatio = Math.floor(total * MAX_RATIO);
    var byCanvas = Math.floor(total - 120);
    return Math.max(MIN_W, Math.min(MAX_CAP, byRatio, byCanvas));
  }

  function clampWidth(w) {
    var n = Number(w);
    if (!isFinite(n)) n = DEFAULT_W;
    return Math.max(MIN_W, Math.min(maxWidth(), Math.round(n)));
  }

  function storedWidth() {
    try {
      var v = parseFloat(localStorage.getItem(STORAGE_KEY));
      return isFinite(v) ? v : DEFAULT_W;
    } catch (e) {
      return DEFAULT_W;
    }
  }

  function applyWidth(w, persist) {
    current = clampWidth(w);
    document.documentElement.style.setProperty('--panel-w', current + 'px');
    var p = panelEl();
    if (p) {
      p.classList.toggle('panel-narrow', current <= 320);
      p.classList.toggle('panel-wide', current >= 560);
    }
    var rz = document.querySelector('.panel-resizer');
    if (rz) rz.setAttribute('aria-valuenow', String(current));
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, String(current)); } catch (e) { /* 隐私模式下忽略 */ }
    }
    return current;
  }

  function onDragStart(rz, panel, e) {
    if (e.button !== 0 || e.isPrimary === false) return;
    e.preventDefault();

    var dragging = true;
    var startX = e.clientX;
    var startW = panel.getBoundingClientRect().width;
    var pending = null;
    var raf = 0;

    rz.classList.add('dragging');
    document.body.classList.add('panel-resizing');
    try { rz.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器忽略 */ }

    function flush() {
      raf = 0;
      if (pending != null) applyWidth(pending, false);
    }

    function onMove(ev) {
      if (!dragging) return;
      // 面板在右边：鼠标往左拖，面板变宽
      pending = startW + (startX - ev.clientX);
      if (raf) return;
      raf = requestAnimationFrame(flush);
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      applyWidth(pending == null ? current : pending, true);
      pending = null;
      rz.classList.remove('dragging');
      document.body.classList.remove('panel-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function makeResizer(panel) {
    var rz = document.createElement('div');
    rz.className = 'panel-resizer';
    rz.setAttribute('role', 'separator');
    rz.setAttribute('aria-orientation', 'vertical');
    rz.setAttribute('aria-label', '拖动调整右侧面板宽度，双击恢复默认宽度');
    rz.setAttribute('aria-valuemin', String(MIN_W));
    rz.setAttribute('title', '拖动调整宽度，双击恢复默认');
    rz.tabIndex = 0;

    rz.addEventListener('pointerdown', function (e) { onDragStart(rz, panel, e); });
    rz.addEventListener('dblclick', function (e) {
      e.preventDefault();
      applyWidth(DEFAULT_W, true);
    });
    rz.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 32 : 8;
      if (e.key === 'ArrowLeft') { e.preventDefault(); applyWidth(current + step, true); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); applyWidth(current - step, true); }
      else if (e.key === 'Home') { e.preventDefault(); applyWidth(DEFAULT_W, true); }
    });
    return rz;
  }

  function init() {
    var main = mainEl();
    var panel = panelEl();
    if (!main || !panel || main.querySelector('.panel-resizer')) return;

    var rz = makeResizer(panel);
    main.insertBefore(rz, panel);
    rz.setAttribute('aria-valuemax', String(maxWidth()));
    applyWidth(storedWidth(), false);

    // 窗口变小：重新夹一次，避免面板把画布压成负宽
    var resizeRaf = 0;
    window.addEventListener('resize', function () {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(function () {
        resizeRaf = 0;
        rz.setAttribute('aria-valuemax', String(maxWidth()));
        applyWidth(current, true);
      });
    });
  }

  // 给自动化测试用的小入口（不影响正常使用）
  window.__PANEL_SPLIT__ = {
    min: MIN_W,
    default: DEFAULT_W,
    max: maxWidth,
    get: function () { return current; },
    set: function (w) { return applyWidth(w, true); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
