# 把 comic-canvas 做成「可安装技能」的改造方案

> 状态：**v3，按 2026-11-19 的反馈修订**（改名、依赖归属、发布方式、
> 配置统一走 settings.json、测试脚本清理）。
> 调研依据见 [research-skill-install.md](research-skill-install.md)。
>
> 反馈确认的三件事：
> 1. 名字重新起（comic-canvas / manga-canvas 只是占位，见第八节）；
> 2. manga-image-translator 是外部 GitHub 项目，用户目录存在就直接用，
>    不存在时由 agent 按说明克隆安装；
> 3. 旧数据不做迁移展示，功能上直接支持用户数据目录即可。

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
| server/canvas.mjs:43 | 写死 manga-image-translator 的 python | 环境变量 MANGA_TRANSLATOR_ROOT，从中推导 python.exe |
| server/canvas.mjs:44 | 写死 ffmpeg | 先用 PATH，再回退绝对路径 |
| server/tools_helpers.js:11-13 | 写死项目根、sessions、settings | 同上，统一由 DATA_HOME 推导 |
| server/render_check.py:32 | 写死 sessions | 环境变量 COMIC_CANVAS_HOME |
| server/render_check.py:113 | 写死 msyh.ttc | 多候选字体 + 找不到时 load_default() |
| server/ocr_service.py:37,40 | 写死 MT 目录并 chdir | 环境变量 MANGA_TRANSLATOR_ROOT，缺失时报错 |
| skills/.../canvas_cli.py:45-48 | 写死 ROOT/SESSIONS/OCR_PY/日志 | COMIC_CANVAS_HOME + COMIC_CANVAS_ROOT 推导 |
| start.bat:6 | 写死 OCR_PY | 从 MANGA_TRANSLATOR_ROOT 推导，缺失时提示 |

## 五点五、manga-image-translator 怎么定位与安装

它是外部 GitHub 项目（zyddnys/manga-image-translator，GPL-3.0，自带 requirements.txt，
模型在运行时自动下载到其 ./models）。设计原则：**能用就不动，缺了就让 agent 装**。

解析顺序（画布服务和技能 CLI 共用同一套规则）：

1. 环境变量 MANGA_TRANSLATOR_ROOT 显式指定；
2. settings.json 里的 translator.projectRoot（这个字段现在已经存在但没人读，正好启用它）；
3. 常见默认位置探测：~/manga-image-translator；
4. 都没有 → 返回明确的「未找到」状态，由调用方决定下一步。

找到后从中推导 python 解释器（py310/python.exe 优先，回退 venv、系统 python），
只做只读使用：sys.path 指过去、模型目录随包推导，不往里面写任何文件。

未找到时，SKILL.md 给 agent 一段安装指引（由 agent 执行，用户确认后进行）：

```text
1. git clone https://github.com/zyddnys/manga-image-translator.git ~/manga-image-translator
2. python -m venv venv && pip install -r requirements.txt
   （Windows 需要 VS Build Tools；GPU 加速需按 pytorch.org 装 CUDA 版 torch）
3. 首次跑识别时模型自动下载到 manga-image-translator/models/（约 490 MB 起）
4. 装完设置 MANGA_TRANSLATOR_ROOT 指向该目录
```

本项目**不 fork、不打包、不自动静默下载** manga-image-translator：

- 它是 GPL 项目，混入自己的 npm 包会有许可证义务；
- 2 GB 模型不该藏在安装流程里；
- agent 按上面四步引导安装，等于把「装依赖」变成一次用户可见的操作。

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

### 阶段 3：发布 GitHub + npm（半天）

发布物就是仓库本身 + npm 包，做到这一步用户即可：

```bash
# GitHub：直接 clone 跑
git clone https://github.com/<you>/manga-panel-studio.git
cd manga-panel-studio && npm install && npm start

# npm：全局装，命令直接可用
npm install -g manga-panel-studio
manga-panel-studio          # 启动画布服务

# 技能装进 agent
npx skills add <you>/manga-panel-studio --skill manga-panel-studio -a codex -y
```

package.json 最小内容：

```json
{
  "name": "manga-panel-studio",
  "version": "0.1.0",
  "bin": { "manga-panel-studio": "./bin/cli.mjs" },
  "scripts": { "start": "node server/canvas.mjs" },
  "engines": { "node": ">=20" },
  "files": ["server", "public", "skills", "bin", "README.md"],
  "postinstall": "node bin/setup-check.mjs"
}
```

几个要点：

- **Node 侧零依赖**这个优势要保持住：不引入任何运行时 npm 依赖，安装永远秒级；
- files 白名单不含 sessions/、docs/images（截图只留在 GitHub README，不进 npm 包）；
- postinstall 只打印「缺什么、去哪装」，绝不静默拉模型；
- 发 npm 前先 npm pack --dry-run 确认体积（预计 < 2.5 MB）。

## 八、按反馈修订的三个结论

1. **前后端是否需要安装依赖？** Node 侧不用（纯内置模块，无 package.json）；
   前端不用（vendor 全本地）；Python 侧只装 manga-image-translator 一件事，
   它的 requirements.txt 就覆盖了本项目全部 Python 依赖（见第九节）。
2. **是否要把所有代码放进 skill 目录？** 不建议。安装器只复制技能目录，
   把 server/public 拷进去会造成两份代码、升级冲突、体积暴涨。
   正确做法：技能=说明书+启动器，应用=GitHub 仓库 + npm 包，两条安装路都通。
3. **sessions / settings / .tmp 放哪？** 统一放用户数据目录
   （Windows %LOCALAPPDATA%/<包名>，macOS/Linux $XDG_DATA_HOME/<包名>）；
   不做旧数据迁移展示。新用户从第一天就是干净的用户目录，
   老用户（你自己）搬一次数据即可，不做自动迁移界面。

## 八、名字怎么起

comic-canvas、manga-canvas 在 npm 上都可注册，但它们更像「类别」不像「产品」。
建议从一个词根派生三件套（GitHub 仓库名 / npm 包名 / 技能名保持一致）：

| 候选 | npm 状态 | 评价 |
| --- | --- | --- |
| **manga-panel-studio** | 空闲 | 漫画分镜工作室：面板 + 校对 + 配音，最贴产品形态，推荐 |
| mangapress | 空闲 | 短，但方向感弱一些 |
| mangastudio | 空闲 | 与 Clip Studio 旧名撞车，容易混淆，不推荐 |
| manga-ocr-canvas | 空闲 | 只强调 OCR，丢了配音这条线 |
| manga-panel | 空闲 | 简洁，但英文里 panel 歧义偏大 |

推荐 **manga-panel-studio**，三件套这样派生：

```text
GitHub:  github.com/<you>/manga-panel-studio
npm:     manga-panel-studio      （bin 同名，全局装完命令就是 manga-panel-studio）
skill:   manga-panel-studio      （skills/manga-panel-studio/SKILL.md）
home:    %LOCALAPPDATA%/manga-panel-studio   （环境变量改叫 MPS_HOME 或 STUDIO_HOME）
```

名字定了后，全局替换一次到位：仓库目录名、package.json、SKILL.md 的 name 字段、
环境变量前缀、settings.json 的 projectRoot 默认值、README 全部同步改。

## 九、Python 依赖归属（按反馈澄清）

| 依赖 | 谁需要 | 说明 |
| --- | --- | --- |
| fastapi、uvicorn、pydantic | 本项目 server/ocr_service.py | 识别服务的 HTTP 壳，与 MT 无关 |
| opencv (cv2)、numpy、pillow | 本项目和 MT 都要 | 图像处理基础库，两边共用 |
| torch + 检测/OCR 模型 | manga_translator | MT 的 dispatch() 用它跑模型，本项目不直接碰 torch |
| manga_translator 包 | 本项目 server/mask_column_ocr.py import 它 | 复用它的检测和 OCR 实现，不自己维护 |
| requests | skills/.../canvas_cli.py | CLI 调画布 HTTP 接口 |

结论：**装好 manga-image-translator，上面这些就全齐了**——它的 requirements.txt
覆盖 fastapi/opencv/torch/numpy 等全部运行依赖。本项目不单独提供 requirements.txt，
避免两套环境互相污染；唯一的约束是那个环境需要 Python 3.10+。

所以用户只需要做一件事：装 manga-image-translator（手动装，或让 agent 按「五点五」
的指引来装）。其余一律不用单独装。

## 十、按 2026-11-19 第三轮反馈的修订

### 1. 两个测试脚本是垃圾，直接删

\`skills/manga-canvas-pipeline/scripts/_h.py\` 和 \`_t2.py\` 是之前调试留下的临时文件，
不是技能的一部分，谁都没引用它们。处理：

- 两个文件直接删掉（\`_h.py\` 未跟踪，删了就没了；\`_t2.py\` 已被 Git 跟踪，
  删除后提交即可从当前版本消失）；
- \`_t2.py\` 里的真实 API key 要去平台后台作废——它已经进 Git 历史，删文件不等于删历史；
- 为了不重蹈覆辙，加一条规则：\`scripts/_*.py\` 一律不进 Git（写进 .gitignore），
  以后临时调试文件放这里自动被忽略；
- 另外把 \`skills/manga-canvas-pipeline/scripts/__pycache__/\` 也加进忽略
  （现在靠全局 \`__pycache__/\` 规则覆盖，显式写一份更保险）。

### 2. 地址写死的问题：统一收口到 settings.json

用户说得对：已经有 settings.json 了，就不该再到处写绝对路径。修订后的设计：

**settings.json 新增结构**（合并进现有文件，老字段全部保留）：

```json
{
  "openai":   { "baseUrl": "...", "apiKey": "...", "model": "..." },
  "doubao":   { "apiKey": "...", "model": "..." },
  "translator": {
    "baseUrl":     "http://127.0.0.1:5009",
    "projectRoot": "D:/manga-image-translator"
  },
  "canvas": {
    "sessionsDir":  "",       // 空 = 默认 %LOCALAPPDATA%/<包名>/sessions
    "dataDir":      "",       // 空 = 默认 %LOCALAPPDATA%/<包名>
    "ocrBaseUrl":   "",       // 空 = 默认 http://127.0.0.1:5009
    "canvasBaseUrl":"",      // 空 = 默认 http://127.0.0.1:7788
    "ffmpegPath":   ""        // 空 = 用 PATH 里的 ffmpeg
  }
}
```

**读取规则（所有代码统一）**：环境变量 > settings.json > 内置默认值。

| 现在写死的地方 | 以后从哪读 | 回退顺序 |
| --- | --- | --- |
| canvas.mjs:41 sessions | settings.canvas.sessionsDir | env STUDIO_SESSIONS_DIR > settings > 默认用户目录 |
| canvas.mjs:42 OCR 地址 | settings.translator.baseUrl | settings > 默认 5009 |
| canvas.mjs:43 PY | settings.translator.projectRoot + settings.json 推导 | env MT_ROOT > settings > PATH python |
| canvas.mjs:44 FFMPEG | settings.canvas.ffmpegPath | settings > PATH > 项目内无 → 原样保存兜底 |
| ocr_service.py:37 MT 目录 | settings.translator.projectRoot | env MT_ROOT > settings > 报错并给安装指引 |
| canvas_cli.py:45-49 | settings.json 同上 | settings > 默认值 |
| tools_helpers.js:11-13 | settings.canvas.dataDir | settings > 默认用户目录 |
| render_check.py:32 sessions | settings.canvas.sessionsDir | settings > 默认 |
| start.bat:6 OCR_PY | settings.translator.projectRoot 推导 | settings > 提示去设置页填 |

关键点：

- **Node 服务自己不写死任何盘符**；启动时读 settings.json，缺失字段用默认值；
- **ocr_service.py 是 Python**，它读同一个 settings.json（标准 json 库即可），
  路径来源唯一，不会出现两边不一致；
- **环境变量只做临时覆盖**（调试、CI 用），日常配置全部在设置页里改；
- 设置页（public/settings.html）加一个「路径与端口」分组，可视化编辑这些字段；
- settings.json 里存的是本机路径，天然不该进 Git（已被忽略），npm 包里只放 example。

### 3. 实施顺序相应调整

原阶段 1（路径改造）拆成两步，先收口配置再动目录：

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| 0 | 删 _h.py、_t2.py；作废泄漏 key；.gitignore 补 \`_*.py\`；package.json；settings.example.json | git log 干净、npm pack 通过 |
| 1a | settings.json 加 canvas/translator 分组；server 四处 + CLI + start.bat 全部改读配置 | 改 settings.json 里的路径，服务行为跟着变 |
| 1b | 数据目录默认值切到 %LOCALAPPDATA%/<包名>；settings 页加路径编辑；旧 sessions 手动搬一次 | 换盘符启动正常 |
| 2 | 技能改名 manga-panel-studio；SKILL.md 精简；scripts/run.mjs 启动器 | npx skills add 本仓库可用 |
| 3 | npm 发布 + GitHub 公开 | 干净机器全流程 |

### 4. 名字确认：manga-panel-studio

按反馈采用推荐候选。全局替换清单（实施时一次性完成）：

```text
skills/manga-canvas-pipeline/     -> skills/manga-panel-studio/
SKILL.md 的 name 字段             -> manga-panel-studio
package.json name/bin             -> manga-panel-studio
环境变量前缀                      -> STUDIO_*（STUDIO_DATA_DIR、STUDIO_SESSIONS_DIR、MT_ROOT 保留）
数据目录                          -> %LOCALAPPDATA%/manga-panel-studio
README / 文档                     -> 同步改名
settings.json                     -> 老字段全兼容，新增 canvas 分组
```
