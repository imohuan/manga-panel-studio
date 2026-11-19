// 自建全屏预览：以鼠标为中心缩放、拖拽平移、双击复位
// 变换公式： screen = world * scale + offset （与画布同一套算法）
(function () {
const { ref, watch, onMounted, onBeforeUnmount, nextTick } = Vue;

window.Lightbox = {
  name: 'Lightbox',
  props: { open: Boolean, src: String, json: [Object, Array], title: String },
  emits: ['update:open'],
  setup(props, { emit }) {
    const stage = ref(null);
    const scale = ref(1);
    const tx = ref(0);
    const ty = ref(0);
    const dragging = ref(false);
    const nat = { w: 0, h: 0 };
    let drag = null;

    const isJson = () => props.json != null;

    function viewSize() {
      const el = stage.value;
      return { w: el ? el.clientWidth : 1, h: el ? el.clientHeight : 1 };
    }

    // 让图片刚好铺满可视区
    function fit() {
      const { w, h } = viewSize();
      if (!nat.w || !nat.h) { scale.value = 1; tx.value = w / 2; ty.value = h / 2; return; }
      const k = Math.min(w / nat.w, h / nat.h);
      scale.value = k;
      tx.value = (w - nat.w * k) / 2;
      ty.value = (h - nat.h * k) / 2;
    }

    function reset() {
      fit();
    }

    function onImgLoad(e) {
      nat.w = e.target.naturalWidth;
      nat.h = e.target.naturalHeight;
      fit();
    }

    function zoomAt(px, py, factor) {
      const next = Math.min(12, Math.max(0.05, scale.value * factor));
      if (next === scale.value) return;
      const k = next / scale.value;
      tx.value = px - (px - tx.value) * k;
      ty.value = py - (py - ty.value) * k;
      scale.value = next;
    }

    function onWheel(e) {
      // JSON 只走浏览器原生滚动，不拦滚轮、不改字号
      if (isJson()) return;
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= 400;
      const r = stage.value.getBoundingClientRect();
      const speed = e.ctrlKey ? 0.0072 : 0.0018;
      // 限幅：一次滚动最多变 1.3 倍，避免滚轮/触控板一次缩到底
      const factor = Math.min(1.3, Math.max(1 / 1.3, Math.exp(-dy * speed)));
      zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    }

    function onDown(e) {
      if (isJson() || e.button !== 0) return;
      e.preventDefault();
      dragging.value = true;
      drag = { sx: e.clientX, sy: e.clientY, ox: tx.value, oy: ty.value, moved: false };
    }
    function onMove(e) {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      tx.value = drag.ox + dx;
      ty.value = drag.oy + dy;
    }
    function onUp() { dragging.value = false; drag = null; }

    function close() { emit('update:open', false); }
    function onKey(e) {
      if (!props.open) return;
      if (e.key === 'Escape') close();
      if (e.key === '0') reset();
    }

    function lockScroll(on) { document.body.style.overflow = on ? 'hidden' : ''; }

    watch(() => props.open, (v) => {
      lockScroll(v);
      if (v) { reset(); nextTick(() => stage.value?.focus()); }
    });
    watch(() => props.src, () => { if (props.open) nextTick(fit); });

    onMounted(() => window.addEventListener('keydown', onKey));
    onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); lockScroll(false); });

    return { stage, scale, tx, ty, dragging, reset, fit, onWheel, onDown, onMove, onUp, close, onImgLoad };
  },
  template: `
  <teleport to="body">
    <div v-if="open" class="lb" @click.self="close">
      <div class="lb-head">
        <span class="material-symbols-outlined">preview</span>
        <span class="lb-title">{{ title || '预览' }}</span>
        <span class="lb-sp"></span>
        <template v-if="!json">
          <span class="lb-zoom">{{ Math.round(scale * 100) }}%</span>
          <button class="lb-btn" @click="fit" title="适配窗口">
            <span class="material-symbols-outlined">fit_screen</span>
          </button>
          <button class="lb-btn" @click="reset" title="复位 (0)">
            <span class="material-symbols-outlined">restart_alt</span>
          </button>
        </template>
        <span class="lb-zoom" v-else>{{ (json.regions || []).length }} 条</span>
        <button class="lb-btn" @click="close" title="关闭 (Esc)">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      <div class="lb-stage" ref="stage" tabindex="0" @wheel="onWheel"
        @mousedown="onDown" @mousemove="onMove" @mouseup="onUp" @mouseleave="onUp"
        :class="{ grabbing: dragging, json: !!json }">
        <img v-if="!json" :src="src" class="lb-img" @load="onImgLoad"
          :style="{ transform: 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')' }"
          @dblclick="reset" draggable="false" />
        <pre v-else class="lb-json">{{ JSON.stringify(json, null, 2) }}</pre>
      </div>
      <div class="lb-foot">
        <span v-if="!json">滚轮以指针为中心缩放 · 拖拽平移 · 双击复位 · Esc 关闭</span>
        <span v-else>滚轮滚动查看 · Esc 关闭</span>
      </div>
    </div>
  </teleport>`,
};
})();

