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
| 2026-11-19 | 多选框 | Shift 多选 + I/O/P 快捷键 + 框内文字批量识别（443947c） | `health-check` 通过 |
| 2026-11-19 | 右侧面板 | 区域列表编号跳转栏、底部编辑框压矮（481485d） | 面板截图 |
| 2026-11-19 | 历史记录 | 中间图落盘、图片格式修正、还原到这一步（56a7e53、099c037） | 历史卡片能显示中间图并可还原 |

## 事故记录：暂存区被两个对话共用

2026-11-19 14:2x，右侧面板和历史记录两个对话同时往 Git 暂存区写。
右侧面板 `git add public/panel.html` 之后，历史记录提交时把这条也带走了；
随后两个对话各自 `git reset --soft HEAD~1` 拆提交，来回折腾了几次。

最终没有丢代码（服务端文件始终留在工作区），但这说明：

**`git add` 和 `git commit` 之间不要有等待。** 要么一条命令连着做完，
要么先 `git diff --cached --stat` 确认只有自己的文件，立即提交。
两个对话同时暂存时，永远只 `git add <自己的具体文件>`，绝不用 `git add -A`。
| 2026-11-19 | 多选框 · 快捷键 | `canvas.js`：Shift 拖动框选 / Shift 点选加减、多选状态 `selExtra`、I/O/P 快捷键、框内文字批量提交、Del 批量删除、导出 `stepBox`/`jumpToIndex`。`panel.html` 只改三个按钮（快捷键角标 + 多选计数）。提交 443947c | `node test/verify-multiselect.mjs` 14 项全过、`node test/verify-panel-smoke.mjs` 5 项全过、`node scripts/health-check.mjs` 全部打勾 |

## 已知问题

- ~~`queuePageDetect` 发送 `detect` 而非 `detect-page`~~：多选框任务已修。

## 同一个文件里的分区（重要）

`public/index.html` 是拼装出来的：服务端会把 `public/panel.html` 整段塞进
`index.html` 的 `<!-- PANEL -->` 位置再返回。所以：

- `index.html` 里的 `<style>` 是**多个对话共用**的，只许追加自己的几行，不许整段替换。
- `panel.html` 里只改自己负责的那一段结构。
- 改完刷新 `http://127.0.0.1:7788/`（Ctrl+F5）就能看到，不需要重启服务。
