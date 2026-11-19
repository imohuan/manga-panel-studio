# 任务分工登记表

多个对话共用一个目录 `I:\comic-canvas`。这份表规定「谁负责哪一块」。
动手前先看这里，再运行 `node scripts/coord.mjs status`。

## 当前分工

| 任务 | 对话 | 负责的文件和区域 | 不要碰 |
| --- | --- | --- | --- |
| 历史记录 · 中间图 | 历史记录 图片保存 | `server/canvas.mjs`、`server/ocr_service.py`、`server/mask_column_ocr.py`、`server/compress_image.py` | 前端三个热文件 |
| 右侧面板 UI | 右侧面板 UI 优化 | `public/panel.html`（布局、吸顶、底部固定）、`public/index.html`（样式） | `public/canvas.js` |
| 多选框 · 快捷键 | 多选框+ 快捷键 | `public/canvas.js`（选区、键盘、多框识别）、`public/panel.html` 的按钮区 | 服务端 |
| 历史记录 · 音频与 AI 校验 | 历史记录 音频与AI校验 | `server/canvas.mjs` 的音频/AI 校验段、`server/tools_helpers.js`、历史卡片展示（`public/canvas.js` 的 `ICON`/`filteredHistory`、`public/panel.html` 历史那一段） | `public/index.html`、分镜接口 |
| 分镜 tab | 分镜 tab 渲染 | `public/storyboard.js`、`public/index.html` 的 `.sb-*` 样式、`panel.html` 里的分镜按钮和挂载点、`server/canvas.mjs` 的 `/storyboard` 段 | 历史卡片、音频/AI 校验逻辑 |
| AI 设置 · 启动自检 | AI 设置 启动自检 | `skills/manga-canvas-pipeline/SKILL.md`、`skills/manga-canvas-pipeline/scripts/canvas_cli.py` | 前端三个热文件 |
| 面板拖拽宽度 | 面板拖拽宽度 | `public/panel-split.js`、`public/index.html` 的 `.main`/`.panel`/`.panel-resizer`/`.logs` | 面板内的 tab 和卡片结构 |

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

### `server/canvas.mjs` 和技能文件也要认领

`server/canvas.mjs` 以前是「谁顺手谁改」，结果两个对话同时往里加接口。
现在它和三个热文件一样要认领，改完立刻 `release`。

同一个文件里按接口分段，互不覆盖：

- **音频历史**：`saveAudio`、`AUDIO_DIR`、`/hist-audio/`、`pruneImages` 里的音频清理。→ 历史记录
- **AI 读图校验**：`/api/session/<画布>/check`、`appendOp` 的 `ai-check`。→ 历史记录
- **分镜**：`/api/session/<画布>/storyboard`（只读 GET）。→ 分镜 tab

技能两个文件（`SKILL.md`、`scripts/canvas_cli.py`）也要认领；改完就提交并释放。

## 改动登记

完成一块就加一行，写清「改了什么、验证方式」，别人就不会重复做：

| 日期 | 任务 | 改了什么 | 验证 |
| --- | --- | --- | --- |
| 2026-11-19 | 协调 | 建立认领工具和本表，存快照 tag `coord-snapshot-20261119` | `node scripts/coord.mjs status` |
| 2026-11-19 | 协调 | 发现右侧面板任务在 index.html 删掉了多选任务的 kbd.hk / sel-count 样式，已按原样恢复（2ea95ee） | 页面源码里三类选择器都在 |
| 2026-11-19 | 多选框 | Shift 多选 + I/O/P 快捷键 + 框内文字批量识别（443947c） | `health-check` 通过 |
| 2026-11-19 | 右侧面板 | 区域列表编号跳转栏、底部编辑框压矮（481485d） | 面板截图 |
| 2026-11-19 | 历史记录 | 中间图落盘、图片格式修正、还原到这一步（56a7e53、099c037） | 历史卡片能显示中间图并可还原 |
| 2026-11-19 | 历史记录 | 展开区说明文字统一为面板小字（9.5px/Geist，正文 11px）；CLI 删框记录框坐标（c0ff2bb） | `health-check` 全过，浏览器实测字号 9.5px |
| 2026-11-19 | 画布下拉 | 左上角原生 `<select>` 换成 UIKit `kit-select`（搜索、键盘上下选择、点击外部/Esc 关闭），`canvas.js` 增加 `sessionOptions` 并在空值时不清空画布（0b0ed5b） | 浏览器点开/搜索/切换画布正常，控制台无报错；`verify-multiselect` 14 项、`verify-panel-smoke` 5 项、`health-check` 全过 |
| 2026-11-19 | 音频弹窗 | 「音频」按钮打开 `/audio.html?s=当前画布`；音频页优先读 `?s=`，切换会话后同步写回地址栏（8cf26c7） | 浏览器实测 Demo2/Demo3 打开即对应画布，刷新后仍一致，控制台无报错；`health-check`、`verify-panel-smoke` 全过 |
| 2026-11-19 | 协调 | 认领清单从 3 个热文件扩到 `server/canvas.mjs` 和技能两个文件；`status` 会单独列出共享后端和技能文档 | `node scripts/coord.mjs status` |
| 2026-11-19 | 分镜 tab | 右侧面板新增「分镜」tab：读 `sessions/<画布>/NNNNN.md` 直接渲染成分镜稿（页面信息、场景、每镜卡片、台词、音效表），按页切换，点了画布上的图会自动跳到对应页。新增独立文件 `public/storyboard.js` + 本地 `public/vendor/marked.min.js`，面板只加一个 `#storyboard-root` 挂载点（2fff715） | 浏览器实测 Demo3/Demo1：分镜 tab 正常显示、切页、无控制台报错；四种 md 写法都能解析 |
| 2026-11-19 | 面板拖拽宽度 | 画布与面板之间加 8px 拖拽条，宽度写进 `--panel-w`：最小 280px、最大 `min(720px, 窗口 60%)`，双击回 336px，宽度存 localStorage，窄窗口自动重夹；`.logs` 改成跟随面板宽度的 CSS 变量。新增独立文件 `public/panel-split.js`，`index.html` 只动布局那几段（29ecf86） | `node test/verify-panel-split.mjs` 16 项全过；`verify-panel-smoke` 5 项、`health-check` 全过；浏览器截图确认拖拽条悬停变蓝、280px 四个 tab 不折行 |

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
