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

## 已知问题

- `public/canvas.js` 里 `queuePageDetect` 发给服务端的模式是 `detect`，
  而服务端只认 `detect-page`，按 `I` 会走到错误的兜底分支。由多选框任务修。
