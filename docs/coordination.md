# 任务分工登记表

多个对话共用一个目录 `I:\comic-canvas`。这份表规定「谁负责哪一块」。
动手前先看这里，再运行 `node scripts/coord.mjs status`。

## 当前分工

| 任务 | 对话 | 负责的文件和区域 | 不要碰 |
| --- | --- | --- | --- |
| 历史记录 · 中间图 | 历史记录 图片保存 | `server/canvas.mjs`、`server/ocr_service.py`、`server/mask_column_ocr.py`、`server/compress_image.py` | 前端三个热文件 |
| 右侧面板 UI | 右侧面板 UI 优化 | `public/panel.html`（布局、吸顶、底部固定）、`public/index.html`（样式） | `public/canvas.js` |
| 多选框 · 快捷键 | 多选框+ 快捷键 | `public/canvas.js`（选区、键盘、多框识别）、`public/panel.html` 的按钮区 | 服务端 |

## 热文件排队

同一时间只允许一个对话改一个热文件。要改就认领：

```powershell
node scripts/coord.mjs claim public/canvas.js --owner "多选框+ 快捷键"
node scripts/coord.mjs verify public/canvas.js
node scripts/coord.mjs release public/canvas.js
```

被占用时不要硬改。可以做只读调研、写方案，或者等对方释放。
如果对方超过 45 分钟没动，先确认，再用 `--takeover` 接管。

## 区域约定（防止同一文件里互相踩）

`public/canvas.js` 很长，按功能分块：

- **选区引擎**：`S.selExtra`、`selectBox`、`toggleBoxSelect`、`clearSelection`、
  `selectedBoxes`、鼠标按下/移动/抬起里的 `kind: 'select'`。→ 多选框任务
- **键盘**：`onKeyDown`、`onKeyUp`、`cycleBox`。→ 多选框任务
- **右侧面板联动**：`revealSelectedBox`、`thumbExtraStyles`、`curBox`。→ 右侧面板任务
- **历史记录**：`loadHistory`、`drawManualCards`、`filteredHistory`、`onToggle`。→ 历史记录任务

要改别人负责的块，先发消息商量，不要直接改。

## 改动登记

完成一块就加一行，写清「改了什么、验证方式」，别人就不会重复做：

| 日期 | 任务 | 改了什么 | 验证 |
| --- | --- | --- | --- |
| 2026-11-19 | 协调 | 建立认领工具和本表，存快照 tag `coord-snapshot-20261119` | `node scripts/coord.mjs status` |
| 2026-11-19 | 协调 | 发现右侧面板任务在 index.html 删掉了多选任务的 kbd.hk / sel-count 样式，已按原样恢复（2ea95ee） | 页面源码里三类选择器都在 |
| 2026-11-19 | 多选框 · 快捷键 | `canvas.js`：Shift 拖动框选 / Shift 点选加减、多选状态 `selExtra`、I/O/P 快捷键、框内文字批量提交、Del 批量删除、导出 `stepBox`/`jumpToIndex`。`panel.html` 只改三个按钮（快捷键角标 + 多选计数）。提交 443947c | `node test/verify-multiselect.mjs` 14 项全过、`node test/verify-panel-smoke.mjs` 5 项全过、`node scripts/health-check.mjs` 全部打勾 |

## 已知问题

- ~~`queuePageDetect` 发送 `detect` 而非 `detect-page`~~：多选框任务已修。

## 同一个文件里的分区（重要）

`public/index.html` 是拼装出来的：服务端会把 `public/panel.html` 整段塞进
`index.html` 的 `<!-- PANEL -->` 位置再返回。所以：

- `index.html` 里的 `<style>` 是**多个对话共用**的，只许追加自己的几行，不许整段替换。
- `panel.html` 里只改自己负责的那一段结构。
- 改完刷新 `http://127.0.0.1:7788/`（Ctrl+F5）就能看到，不需要重启服务。
