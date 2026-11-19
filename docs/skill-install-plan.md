# 把 comic-canvas 做成「可安装技能」的改造方案

> 状态：**只调研，未改代码**。本文是方案，等你确认后再分阶段实施。
> 日期：2026-11-19。调研依据见 [research-skill-install.md](research-skill-install.md)。

## 一、先把结论说清楚

### 1. 技能安装器只装「技能目录」，不装整个仓库

我在临时目录实测了一次（没有碰本项目）：

```text
npx skills add I:/comic-canvas --skill manga-canvas-pipeline -a codex -y

结果只复制了 4 个文件（约 87 KB）到临时项目：
  .agents/skills/manga-canvas-pipeline/SKILL.md
  .agents/skills/manga-canvas-pipeline/scripts/canvas_cli.py
  .agents/skills/manga-canvas-pipeline/scripts/_h.py
  .agents/skills/manga-canvas-pipeline/scripts/_t2.py

server/、public/、sessions/ 一个都没有。
```

所以：**不能靠「把整个项目塞进 skills/」实现一条命令装完**。
技能本身只能是「说明书 + 启动器」，真正的应用要由另一种方式提供。

### 2. 复制安装是默认路径，不能靠相对路径找回仓库

- 官方推荐：共享一份副本，各 agent 目录做软链；
- 实测：单装一个 agent 时是**直接复制**，--copy 也强制复制；
- 复制后 ~/.agents/skills/<名>/ 的父目录是 skills，再往上是用户主目录，**和仓库无关**。

结论：技能脚本里只能找「已安装的应用」（npm 包 / 环境变量 / 用户配置），
不能写相对路径如 ../../server。

### 3. 前后端依赖：Node 不用装，Python 必须装

| 部分 | 第三方依赖 | 结论 |
| --- | --- | --- |
| 画布服务 server/*.mjs | 只用 Node 内置模块 | node server/canvas.mjs 直接跑，无需 npm install |
| 前端 public/ | Vue/marked/字体已在 public/vendor | 无构建、无安装 |
| 识别服务 server/*.py | fastapi、uvicorn、opencv、numpy、pillow、pydantic | **必须装** |
| 识别算法 | manga_translator 包、torch、两个模型权重 | **必须装，体积大** |
| 技能 CLI | requests | 跟随识别环境即可 |

模型最小集合约 490 MB（检测 294 MB + OCR 195 MB），整个 models/ 约 2.2 GB。
这部分不能放进技能目录，也不适合让安装器静默下载。

### 4. 数据必须移出安装目录

技能目录会随 npx skills update 被覆盖；复制安装还会在多处产生副本。
把 sessions/ 和 settings.json 放进去，升级一次就丢一次。

## 二、推荐的仓库结构

保留现在的仓库根作为「完整应用」，技能只放薄薄一层：

```text
comic-canvas/
|- package.json                 新增：给应用一个命令名（bin: comic-canvas）
|- server/                      现有后端，基本不动
|- public/                      现有前端，基本不动
|- skills/
|   +- manga-canvas-pipeline/   现有技能（建议改名为 comic-canvas）
|       +- SKILL.md             只写流程、命令、排查
|       +- scripts/
|       |   +- canvas_cli.py    现有 CLI
|       |   +- run.mjs          新增：找应用、起服务、等健康检查
|       +- references/
|           +- setup.md         依赖与模型安装说明
|- sessions/                    开发期数据（发布时忽略）
|- docs/
```

为什么不在技能目录里放一份 server/ 和 public/ 的拷贝：

- 两份代码会分叉，改一边另一边不生效；
- 安装器会把整份拷贝进用户目录，升级时又覆盖，体积翻倍；
- 前端要读 public/vendor 里的字体和 Vue，路径一断页面就白屏。

## 三、应用怎么被找到

技能里的启动器按固定顺序找应用，找到第一个就用：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 环境变量 COMIC_CANVAS_ROOT | 用户显式指定，优先级最高 |
| 2 | 已安装的 npm 包 comic-canvas | require.resolve 定位 |
| 3 | 用户配置里记录的路径 | 首次运行向导写入 |
| 4 | 当前工作目录 | 用户就在仓库根时直接可用 |

找不到时**停下来**，明确告诉用户两条路，不要猜：

```text
没找到画布应用。请二选一：
  npm install -g comic-canvas
  git clone <repo> && cd comic-canvas
装好后重试；也可以设置 COMIC_CANVAS_ROOT 指向现有目录。
```

## 四、数据与临时文件放哪

新增一个统一入口 COMIC_CANVAS_HOME，一处配置、两套默认值：

```text
COMIC_CANVAS_HOME（可选）
  Windows 默认：%LOCALAPPDATA%/comic-canvas
  macOS/Linux 默认：$XDG_DATA_HOME/comic-canvas，未设置时 $HOME/.local/share/comic-canvas

  sessions/         画布数据（图片、框 JSON、历史、音频）
  settings.json     用户配置与密钥
  cache/            可删缓存（校对图、临时图）
  logs/             两个服务的日志
```

具体对应：

| 现在的位置 | 改成 | 谁在用 |
| --- | --- | --- |
| I:/comic-canvas/sessions | HOME/sessions | canvas.mjs、tools_helpers.js、render_check.py、canvas_cli.py |
| I:/comic-canvas/settings.json | HOME/settings.json | tools_helpers.js、canvas_cli.py |
| I:/comic-canvas/.tmp | HOME/cache | canvas_cli.py 的日志、临时图 |

两点说明：

- settings.json 里是 API key，属于不可再生数据，放 %LOCALAPPDATA% 比放 %APPDATA% 更合适（不会被漫游到别的机器）；
- 缓存和日志可以随时删，单独放 cache/、logs/，方便用户清理。

第一次运行做一次**只读迁移**：新目录为空且旧目录存在时，复制旧数据过去，
并在页面/CLI 里提示「数据已复制到新位置，旧目录保留未删」。不主动删任何东西。

## 五、需要改的硬编码路径（清单）

这是「搬家会坏」的全部位置，共 9 处：

| 文件:行 | 现在 | 改成 |
| --- | --- | --- |
| server/canvas.mjs:41 | 写死 sessions 绝对路径 | path.join(DATA_HOME, 'sessions') |
| server/canvas.mjs:43 | 写死 manga-image-translator 的 python | 环境变量 COMIC_CANVAS_PYTHON，回退 PATH |
| server/canvas.mjs:44 | 写死 ffmpeg | 先用 PATH，再回退绝对路径 |
| server/tools_helpers.js:11-13 | 写死项目根、sessions、settings | 同上，统一由 DATA_HOME 推导 |
| server/render_check.py:32 | 写死 sessions | 环境变量 COMIC_CANVAS_HOME |
| server/render_check.py:113 | 写死 msyh.ttc | 多候选字体 + 找不到时 load_default() |
| server/ocr_service.py:37,40 | 写死 MT 目录并 chdir | 环境变量 MANGA_TRANSLATOR_ROOT，缺失时报错 |
| skills/.../canvas_cli.py:45-48 | 写死 ROOT/SESSIONS/OCR_PY/日志 | COMIC_CANVAS_HOME + COMIC_CANVAS_ROOT 推导 |
| start.bat:6 | 写死 OCR_PY | 读环境变量，没设时提示 |

## 六、发布前必须先处理的安全问题

这一节和「安装方式」无关，但**推到 GitHub 前必须做**，否则会泄密：

1. skills/manga-canvas-pipeline/scripts/_t2.py 第 3 行有一个真实的 OpenAI API key，
   而且从初始提交起就被 Git 跟踪了。必须删文件，并考虑清理历史（或直接废弃该仓库重新建）。
2. .tmp/ 目录 40.6 MB，里面有 Chrome 调试 profile（Cookies、History）和会话图片，
   .gitignore 现在只忽略 .tmp-*，匹配不到 .tmp/，要加一行 .tmp/。
3. .cdp-* 四个目录共约 50 MB，都是 Chrome 远程调试的用户数据（含登录态），
   已被忽略规则覆盖，但打包 zip 时要手动排除。
4. sessions/ 34 MB 是你自己的漫画数据和音频，默认不发布；
   如果要放一张演示图进 README，单独挑一张无版权风险的。
5. settings.json 已被忽略但就在项目根；发布前加一份 settings.example.json（只有字段名没有值）。
6. 仓库还没有 remote；git ls-files 当前共 60 个文件、约 4.8 MB，实际发布体积很小。

## 七、分阶段实施（每步都可独立验证）

### 阶段 0：清理与发布准备（半天）

- 删 _t2.py、_h.py，处理 key 泄漏；
- .gitignore 加 .tmp/；
- 加 package.json（name、version、bin、engines.node>=20）；
- 加 settings.example.json；
- 建 GitHub 仓库，推第一个版本。

### 阶段 1：路径与数据目录改造（1 天）

- server 侧引入 COMIC_CANVAS_HOME（默认 LOCALAPPDATA / XDG_DATA_HOME）；
- canvas.mjs、tools_helpers.js、render_check.py、canvas_cli.py 全部去掉写死路径；
- 加 COMIC_CANVAS_PYTHON、MANGA_TRANSLATOR_ROOT 两个环境变量；
- 首次运行做旧数据只读迁移；
- 验证：把项目搬到另一个盘符，服务照常启动、历史正常读写。

### 阶段 2：技能变薄（半天）

- SKILL.md 精简到 500 行以内，安装、启动细节挪到 references/setup.md；
- 新增 scripts/run.mjs 启动器（找应用、起服务、轮询健康检查）；
- canvas_cli.py 的服务地址从写死端口改为读 COMIC_CANVAS_HOME 配置或 CLI 参数；
- 验证：npx skills add 本仓库 --skill manga-canvas-pipeline -a codex -y，
  在干净目录里按 SKILL.md 指引能完成 doctor / 启动 / 建画布。

### 阶段 3：npm 发布（可选，半天）

- npm publish，让用户 npm i -g comic-canvas 后拿到完整应用；
- 技能的 run.mjs 就能通过包名定位应用；
- README 补两条安装路径；
- 验证：干净机器上 npm i -g + npx skills add，全流程可用。

## 八、你最初三个问题的直接回答

1. **前后端是否需要安装依赖？** Node 侧不用（纯内置模块，无 package.json）；
   前端不用（vendor 全本地）；Python 侧必须装（fastapi/opencv/torch/模型权重），
   这部分无法靠技能安装器解决，要么用户自己装 manga-image-translator，要么将来把 OCR 服务做成可选的 uvx 工具。
2. **是否要把所有代码放进 skill 目录？** 不建议。安装器只复制技能目录，
   把 server/public 拷进去会造成两份代码、升级冲突、体积暴涨。
   正确做法：技能=说明书+启动器，应用=仓库或 npm 包。
3. **sessions / settings / .tmp 放哪？** 统一搬到用户数据目录：
   Windows %LOCALAPPDATA%/comic-canvas，macOS/Linux $XDG_DATA_HOME/comic-canvas。
   .tmp 这种缓存放 HOME/cache，日志放 HOME/logs。开发期可以在项目里用环境变量覆盖，
   但默认值必须指向用户目录，这样别人装完就能用。

## 九、决策点（需要你拍板）

| 问题 | 选项 A | 选项 B | 我的倾向 |
| --- | --- | --- | --- |
| 技能名 | 保留 manga-canvas-pipeline | 改成 comic-canvas，和包名一致 | B，安装列表更清晰 |
| Python 依赖 | 用户自装 manga-image-translator（现状） | 未来做 uvx 可选包 | 先 A，B 以后再说 |
| settings 迁移 | 自动复制旧数据 | 只提示，用户自己搬 | A，但要保留旧目录不删 |
| 是否发 npm 包 | 只发 GitHub，用户 clone | 发 npm，支持 npx | 先 GitHub，包体小可以随时发 |

确认这四个决策点后，就可以按阶段 0-3 开工。
