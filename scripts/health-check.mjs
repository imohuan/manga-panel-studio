#!/usr/bin/env node
/**
 * 改完之后的自检：确认服务返回的页面里，关键结构都还在。
 * 多人同时改同一份 HTML/CSS 时，最容易出的事故就是「别人的块被删了却没人发现」。
 */
const BASE = process.env.CANVAS_URL || 'http://127.0.0.1:7788';

const MUST_HAVE_HTML = [
  ['.detail-top', '右侧面板顶部固定区'],
  ['.detail-scroll', '右侧面板滚动区'],
  ['.detail-foot', '右侧面板底部编辑区'],
  ['.jump-bar', '编号跳转栏'],
  ['.actions kbd.hk', '快捷键角标样式'],
  ['.sel-count', '多选计数样式'],
  ['.box-item.on.main', '主框/附加框区分样式'],
  ['.trace-grid', '历史中间图网格'],
  ['<canvas ref="cv">', '主画布'],
  ['id="app"', '应用挂载点'],
];

const MUST_HAVE_JS = [
  ['function selectBox', '选框'],
  ['function toggleBoxSelect', 'Shift 多选'],
  ['function selectedBoxes', '多选集合'],
  ['function queueBoxOcr', '框内识别'],
  ['function drawManualCards', '手动改框历史绘制'],
  ['detect-page', '整页找框模式'],
];

const get = async (p) => {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(p + ' -> ' + r.status);
  return r.text();
};

let bad = 0;
const report = (title, list, text) => {
  console.log(title);
  for (const [needle, label] of list) {
    const ok = text.includes(needle);
    if (!ok) bad++;
    console.log((ok ? '  ✓ ' : '  ✗ 缺失：') + label + (ok ? '' : '  (' + needle + ')'));
  }
  console.log('');
};

try {
  report('页面结构', MUST_HAVE_HTML, await get('/'));
  report('画布脚本', MUST_HAVE_JS, await get('/canvas.js'));
  const health = await (await fetch(BASE.replace(':7788', ':5009') + '/health')).json();
  console.log('识别服务：' + (health.ok ? '✓ 正常' : '✗ 异常') + ' (device=' + health.device + ')');
  if (!health.ok) bad++;
} catch (e) {
  console.error('自检失败：' + e.message);
  process.exitCode = 1;
}

console.log(bad ? `\n发现 ${bad} 处缺失，先查是不是被别的对话覆盖了。` : '\n全部通过。');
if (bad) process.exitCode = 1;
