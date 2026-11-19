# 把 comic-canvas 发布成可安装的 AI 技能：官方规范调研

> 调研日期：2026-11-19。本文只做联网核实，没有修改项目代码。
> 标注方式：**【官方】** = 规范或产品文档原文；**【实测】** = 在本机用临时目录跑出来的结果；**【社区】** = 开源项目或作者实践，不是规范要求。

## 先给结论

1. 一个 skill 就是「一个目录 + 一个 `SKILL.md`」，不需要 `package.json`。`npx skills add` 只安装被选中的 skill 目录，**不会**把仓库根目录的 `server/`、`public/` 一起带上。想装完整应用，得另发 npm 包、发布独立仓库，或让用户在仓库根目录运行。
2. `npx skills add` 默认装进**当前项目**（`.agents/skills/` 或 `.claude/skills/` 等），加 `-g` 才装到用户目录。官方推荐**软链**到一份共享副本，但官方 API 文档也写了「目标目录不同才软链，否则复制」；实测只选一个 agent 时就是**复制**。复制/软链装好后，`~/.claude/skills/<名>/` 里只有 skill 目录自己的文件。
3. Node/Python 运行时没有「skill 自动装依赖」的官方机制。官方文档的态度是：在 `compatibility` 里写明环境要求，脚本自己检查并给出可执行的安装提示。主流做法是 `npx <包>` / `uvx <包>` 运行时再拉，或者让用户先装好；**不要**假设 `postinstall` 会执行。
4. `sessions/`、`settings.json` 这类可变数据**不能**放在 skill 目录里。skill 目录会随升级被替换，复制安装时还会在多处产生副本。应放到用户数据目录；Claude Code 的插件有官方变量 `${CLAUDE_PLUGIN_DATA}`（`~/.claude/plugins/data/<id>/`，跨升级保留），普通 skill 没有这个变量，需要自己按 XDG / Windows 规则选目录。
5. 推荐布局：仓库根保留完整应用，skill 放 `skills/<name>/`，skill 里带一个薄的启动器（解析仓库位置 → 启动服务）。这样 `npx skills add <repo>` 装的是说明和启动器，应用仍由仓库或 npm 包提供。

---

## 1. Agent Skills 的目录规范

### 1.1 目录结构

【官方】规范要求一个 skill 至少包含 `SKILL.md`，可选 `scripts/`、`references/`、`assets/`，也可以有任意其他文件。规范和 Codex 文档都强调「progressive disclosure」：启动时只加载 `name` + `description`，命中后才读完整 `SKILL.md`，再按需读 `references/` 和运行 `scripts/`。所以主文件要短，细节拆出去。

```text
skill-name/
├── SKILL.md          # 必需：元数据 + 指令
├── scripts/          # 可选：可执行代码
├── references/       # 可选：按需阅读的文档
├── assets/           # 可选：模板、图片、数据
└── ...               # 其他文件也可以
```

来源：<https://agentskills.io/specification>

### 1.2 frontmatter 字段

【官方】必需字段只有两个：

| 字段 | 必需 | 约束 |
| --- | --- | --- |
| `name` | 是 | 1–64 字符，只能小写字母、数字、连字符；不能以连字符开头/结尾；不能有连续 `--`；**必须与父目录同名** |
| `description` | 是 | 1–1024 字符，非空，写清「做什么」和「什么时候用」 |

可选字段：`license`、`compatibility`（最多 500 字符，写运行环境要求，如「Requires Python 3.14+ and uv」）、`metadata`（字符串到字符串的映射）、`allowed-tools`（实验性）。

来源：<https://agentskills.io/specification>

【社区】注意：`npx skills` 的创建文档只强制 `name` 和 `description`，并允许 `metadata.internal: true` 隐藏内部 skill。这是 CLI 的扩展，不是跨 agent 标准；发布给所有人的 skill 不要依赖 `internal`。
来源：<https://github.com/vercel-labs/skills/blob/main/docs/creating-skills.md>

【官方】Claude Code 还支持 `disable-model-invocation`、`user-invocable`、`paths` 等扩展字段；这些**不属于**通用规范，别的 agent 可能忽略。
来源：<https://code.claude.com/docs/en/skills>

### 1.3 子目录约定

【官方】`scripts/` 放可执行代码，要求「自包含或清楚写明依赖」；`references/` 放详细文档；`assets/` 放模板和静态资源。SKILL.md 里的文件引用用**相对于 skill 根目录**的路径，且不要嵌套太深。主文件建议 500 行以内。
来源：<https://agentskills.io/specification>

【官方】Codex 的 skill 结构相同，另外可以加 `agents/openai.yaml` 声明界面信息和工具依赖。
来源：<https://developers.openai.com/codex/skills>

【官方】Codex 还说明：初始技能列表默认最多占上下文窗口的 2%，或 8000 字符；技能多时会先压缩描述，甚至省略。因此 `description` 要把触发词放前面，别写太长。
来源：<https://developers.openai.com/codex/skills>

---

## 2. `npx skills` 与各家安装机制

### 2.1 安装位置

【官方】`npx skills add` 的默认范围是**当前项目**，`-g` 才是用户级：

| 范围 | 参数 | 位置 |
| --- | --- | --- |
| 项目 | 默认 | `./<agent>/skills/` |
| 全局 | `-g` | `~/<agent>/skills/` |

来源：<https://github.com/vercel-labs/skills/blob/main/docs/commands.md>

【官方】不同 agent 的路径不同，常用的：

| Agent | 项目目录 | 全局目录 |
| --- | --- | --- |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Codex / Cline / Cursor / Gemini CLI 等通用 | `.agents/skills/` | `~/.agents/skills/` |

来源：<https://github.com/vercel-labs/skills/blob/main/docs/agents.md>

【官方】Codex 自己扫描 `.agents/skills`（从当前目录一直到仓库根）和 `~/.agents/skills`，也跟随软链。
来源：<https://developers.openai.com/codex/skills>

### 2.2 复制还是软链

【官方】交互安装时可选：

- **Symlink（推荐）**：先放一份「规范副本」，再从各 agent 目录软链过去，单一来源、方便更新。
- **Copy**：每个 agent 各复制一份，适合不支持软链的环境；`--copy` 可强制复制。

来源：<https://github.com/vercel-labs/skills/blob/main/docs/commands.md>

【官方】CLI 参考文档还写了默认规则的原文：「Without `mode`, skills are **symlinked from one shared copy when targets use different directories, and copied otherwise**.」
来源：<https://github.com/vercel-labs/skills/blob/main/docs/api.md>

【实测】本机 Windows 上的行为（skills 1.9.0，临时目录）：

- 只选一个 agent（如 `-a codex`）时，直接**复制**到 `.agents/skills/<名>/`，输出 `(copied)`。
- 选 Claude Code 时同样复制到 `.claude/skills/<名>/`，输出 `copy → Claude Code`。
- 同时选 Codex + Claude Code 时，`.agents/skills/<名>/` 是那份**复制**的规范副本，`.claude/skills/<名>` 是指向它的 **Junction**（Windows 的目录软链）。
- 源码里 `defaultInstallMode()` 的规则是：所有目标的 skills 目录相同（或只有 eve）就 `copy`，跨多个不同目录才 `symlink`。Windows 上软链用 junction。

这解释了为什么单装一个 agent 时看不到软链。

**对发布者的含义**：不要假设用户装完一定是软链。复制安装是常见路径，所以 skill 里不能写「相对路径回到仓库」，也不能把用户数据放在 skill 目录。

【官方/实现】源码也确认：复制时只复制 skill 目录，跳过 `.git`、`__pycache__`、`__pypackages__` 和 `metadata.json`。
来源：<https://github.com/vercel-labs/skills>（1.9.0 包内实现 `copyDirectory`）

### 2.3 升级、卸载

【官方】

- `npx skills update [名]` 重新拉源并覆盖已安装的 skill；项目安装记录在 `skills-lock.json`，全局安装有全局锁。
- `npx skills check` 检查更新，也会报告文件内容与锁文件哈希不一致（本地改过）。
- `npx skills remove [名]` 删除已安装的 skill；`--all` 只删锁文件里记录的，手写的不动。
- `skills-lock.json` 记录来源、commit 和内容哈希；升级会换文件。**因此 skill 目录里不能放用户数据。**

来源：<https://github.com/vercel-labs/skills/blob/main/docs/commands.md>

### 2.4 仓库内子目录的发现规则

【官方】CLI 会在这些容器目录里找 `SKILL.md`，最多向下 3 层，支持：

- 根目录（如果根本身有 `SKILL.md`）
- `skills/<名字>/SKILL.md`
- `skills/<分类>/<名字>/SKILL.md`
- `skills/<分类>/<分类>/<名字>/SKILL.md`
- `.agents/skills/`、`.claude/skills/` 等各 agent 目录
- `skills.sh.json` 的 `paths` 可加自定义目录
- `.claude-plugin/marketplace.json` / `plugin.json` 里声明的 skill 路径

浅层的 `SKILL.md` 会遮蔽下方同名的；标准位置找不到时才递归搜索。

来源：<https://github.com/vercel-labs/skills/blob/main/docs/creating-skills.md>

### 2.5 用 npm 包分发 skill

【官方】`npx skills experimental_sync` 会读取 `package.json` 依赖里带的 skill（根 `SKILL.md`、`skills/<名>/SKILL.md` 或 `dist/skills/<名>/SKILL.md`），链接到 `.agents/skills/`。这是实验功能。`package.json` 也可以写 `skills` 数组声明 skill 包。
来源：<https://github.com/vercel-labs/skills/blob/main/docs/commands.md>

### 2.6 官方更推荐用 plugin 分发完整能力

【官方】Codex 文档明确写：直接放 skill 目录适合本地编写和仓库内使用；要分发给别人、或一次带多个 skill / MCP / 资源时，应打包成 **plugin**。「For installable distribution, prefer plugins.」
来源：<https://developers.openai.com/codex/skills>

【官方】Claude Code 对 plugin 的定义也是「一组 skill、agent、hook、MCP 作为一个单位安装和加载」。如果你要把「画布应用 + 技能」一起发，plugin 比单个 skill 更合适。
来源：<https://code.claude.com/docs/en/plugins>

但 `npx skills add` 对单个 skill 仍然可用；两条路可以并存：skill 做轻量入口，plugin 做完整分发。

---

## 3. 带 Node / Python 运行时的主流做法

### 3.1 官方怎么说

【官方】规范只要求脚本「自包含或清楚写明依赖」，并在 `compatibility` 里写环境要求；没有「安装 skill 时自动装依赖」的机制。示例：

```yaml
compatibility: Requires Python 3.14+ and uv
```

来源：<https://agentskills.io/specification>

【官方】另外注意：`npx skills` CLI 自己要求 **Node.js 22.20 或更高**。这是安装技能的前置条件，和技能内部的运行时是两件事。
来源：<https://github.com/vercel-labs/skills#install-a-skill>

【官方】Codex 明确建议：能用说明解决就不要写脚本；需要外部工具时，在 `agents/openai.yaml` 的 `dependencies.tools` 里声明（目前主要描述 MCP 工具），而不是假设安装器会装运行时。
来源：<https://developers.openai.com/codex/skills>

### 3.2 两种可复用的运行时方式

【官方】`npx`：本地没有该包时，会把包下载到 npm cache 的目录并临时放进 PATH，用完不常驻。适合「一次跑一个命令」。
来源：<https://docs.npmjs.com/cli/v11/commands/npx>

【官方】`uvx`（即 `uv tool run`）：依赖装进临时虚拟环境，隔离于当前项目；环境缓存在 uv cache，可随时清理重建。适合 Python CLI。
来源：<https://docs.astral.sh/uv/concepts/tools/>

【官方】如果 Python 脚本有少量依赖，也可以把依赖写在脚本头部（PEP 723 内联元数据），用 `uv run script.py` 执行；uv 会自动建环境。规范见 PEP 723，现行文本在 Python Packaging User Guide。
来源：<https://peps.python.org/pep-0723/>
来源：<https://docs.astral.sh/uv/guides/scripts/#declaring-script-dependencies>

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow", "requests"]
# ///
```

适合 skill 自带的小工具；如果依赖是项目里的私有代码或需要 GPU 的大包，仍然应该走项目自己的 Python 环境，不要塞进 skill。

### 3.3 `postinstall` 能不能依赖？

【官方】不能作为通用方案：

- `npx skills` 不是 npm 包安装流程，不会运行你仓库的 `postinstall`。
- Claude Code 安装插件时，即使自动装 npm 依赖，也明确使用 `--ignore-scripts`，**不执行** `preinstall/install/postinstall`；且只支持 registry 包、60 秒超时、不支持 Python。

来源：<https://code.claude.com/docs/en/plugins/loading#limits-on-the-dependency-install>

所以稳妥的顺序是：**先检查 → 缺什么就打印一条用户能直接复制的安装命令 → 让用户确认后再装**。skill 里不要静默下载大型运行时。

【补充】安装器复制 skill 时会跳过 `.git`、`__pycache__`、`__pypackages__` 和 `metadata.json`，但**不会**跳过 `node_modules`。所以不要把 `node_modules` 或虚拟环境放进 skill 目录，否则会被一起复制、计算哈希。

### 3.4 真实例子怎么处理

- **agent-browser**（Vercel Labs）：skill 只是「发现入口」，要求先 `npm install -g agent-browser`，SKILL.md 里直接带安装命令；应用本体是 npm 包，不在 skill 目录里。
  来源：<https://github.com/vercel-labs/agent-browser/blob/main/skills/agent-browser/SKILL.md>
- **chrome-devtools-mcp**：skill 依赖全局 `npm i chrome-devtools-mcp@latest -g` 提供的 `chrome-devtools` 命令；安装说明单独放 `references/installation.md`。
  来源：<https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/skills/chrome-devtools-cli/references/installation.md>
- **mcp2cli**：skill 里直接写 `uvx mcp2cli` / `pip install mcp2cli`，运行时用 uvx 拉起，不需要把 Python 源码塞进 skill。
  来源：<https://github.com/knowsuchagency/mcp2cli/blob/main/skills/mcp2cli/SKILL.md>
- **browser-use**：在 SKILL.md 的 `metadata.openclaw` 里声明 `uv` 安装方式和需要的 bin，属于特定 agent 的扩展声明，不是通用规范。
  来源：<https://github.com/browser-use/browser-use/blob/main/skills/browser-use/SKILL.md>

---

## 4. 可变数据放哪里

### 4.1 为什么不能放 skill 目录

【官方】Claude Code 插件文档明确写了两句话：

- 「Each version has its own cache directory, so the path changes when the plugin updates. **Don't write state there**.」
- 「`${CLAUDE_PLUGIN_DATA}`: a directory that **survives updates**, for `node_modules`, virtual environments, and caches.」

插件缓存是「一个版本一个目录」：`cache/<marketplace>/<plugin>/<version>/`；升级会换到新目录。官方还专门说明「Because `${CLAUDE_PLUGIN_ROOT}` points at a version directory, a plugin's root path changes with every version. Keep a plugin's durable files in `${CLAUDE_PLUGIN_DATA}` instead.」

来源：<https://code.claude.com/docs/en/plugins/components#path-variables-and-persistent-data>
来源：<https://code.claude.com/docs/en/plugins/loading#find-plugins-on-disk>

也就是说：**官方没有说「skill 目录是只读的」，但明确说「安装目录每个版本会变，不要把状态写进去」**。对普通 skill，`npx skills update` 会重新下载并覆盖同名 skill（官方原文：同名安装「overwrites the first」），效果一样：目录内容会被替换。

来源：<https://github.com/vercel-labs/skills/blob/main/docs/commands.md#renaming-a-skill>

【官方】Claude Code 对从 claude.ai 同步的 skill 也写明：改动 `~/.claude/skills/synced/` 里的文件不会保存，后续同步「can overwrite or remove it」。这进一步说明 skills 目录是「安装产物」，不是用户数据区。
来源：<https://code.claude.com/docs/en/skills>

【官方】Codex 文档没有逐字写「skill 目录只读」，但也把 skill 位置定义为「authoring and local discovery」，并建议分发用 plugin；这说明 skill 目录是代码/说明的载体，不是数据目录。
来源：<https://developers.openai.com/codex/skills>

【实测】本机装到 `.claude/skills/<名>/` 后，目录里只有 `SKILL.md` 和 `scripts/`，没有任何仓库外文件。

**结论**：不要依赖「skill 目录只读」这个说法；可靠的做法是把它当**安装目录**——升级会换、复制会产生多份，所以用户数据一律外置。

### 4.2 XDG 规范（Linux / macOS 通用约定）

【官方】XDG Base Directory Specification：

| 变量 | 用途 | 未设置时默认 |
| --- | --- | --- |
| `XDG_DATA_HOME` | 用户数据 | `$HOME/.local/share` |
| `XDG_CONFIG_HOME` | 用户配置 | `$HOME/.config` |
| `XDG_STATE_HOME` | 跨重启保留的状态（历史、布局、撤销记录） | `$HOME/.local/state` |
| `XDG_CACHE_HOME` | 可丢弃的缓存 | `$HOME/.cache` |
| `XDG_RUNTIME_DIR` | 运行时文件（socket 等），登录期间有效 | 无默认 |

来源：<https://specifications.freedesktop.org/basedir-spec/latest/>

### 4.3 Windows 对应关系

【官方】Windows 的 Known Folder：

| 用途 | 变量 | 默认路径 |
| --- | --- | --- |
| 本机数据/缓存 | `%LOCALAPPDATA%` | `%USERPROFILE%\AppData\Local` |
| 可漫游的配置 | `%APPDATA%` | `%USERPROFILE%\AppData\Roaming` |

来源：<https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid>

实际项目里的对应习惯（【社区】但很常见，uv 也这么做）：

| 概念 | Linux/macOS | Windows |
| --- | --- | --- |
| 数据（要备份） | `$XDG_DATA_HOME/<app>` | `%LOCALAPPDATA%\<app>\data` 或 `%APPDATA%\<app>` |
| 配置 | `$XDG_CONFIG_HOME/<app>` | `%APPDATA%\<app>` |
| 缓存 | `$XDG_CACHE_HOME/<app>` | `%LOCALAPPDATA%\<app>\cache` |
| 状态/历史 | `$XDG_STATE_HOME/<app>` | `%LOCALAPPDATA%\<app>\state` |

uv 的官方存储文档就是这个映射：持久数据 `$XDG_DATA_HOME/uv` / `%APPDATA%\uv\data`，缓存 `$XDG_CACHE_HOME/uv` / `%LOCALAPPDATA%\uv\cache`。
来源：<https://docs.astral.sh/uv/reference/storage/>

### 4.4 Claude Code 的插件数据目录（官方确认）

【官方】Claude Code 插件有三个路径变量：

| 变量 | 含义 | 用途 |
| --- | --- | --- |
| `${CLAUDE_PLUGIN_ROOT}` | 当前版本的安装目录，每个版本不同 | 只读的脚本、资源 |
| `${CLAUDE_PLUGIN_DATA}` | `~/.claude/plugins/data/<id>/`，第一次引用时创建，**跨升级保留** | `node_modules`、虚拟环境、缓存、生成文件 |
| `${CLAUDE_PROJECT_DIR}` | 当前项目目录 | 项目内文件 |

官方原文：「Don't write state there」「a directory that survives updates, for `node_modules`, virtual environments, and caches」。卸载最后一个插件时会删除该目录（可用 `--keep-data` 保留）。

来源：<https://code.claude.com/docs/en/plugins/components#path-variables-and-persistent-data>
来源：<https://code.claude.com/docs/en/plugins-reference#environment-variables>

【官方】Codex 的 plugin hooks 也提供 `PLUGIN_ROOT` 和 `PLUGIN_DATA`，并为了兼容同时设置 `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`。
来源：<https://developers.openai.com/plugins/build/plugins>

【官方】普通 skill（不是插件）只有 `${CLAUDE_SKILL_DIR}`，指向 skill 自己的目录；没有 `SKILL_DATA` 之类的变量。所以普通 skill 要存数据，只能自己选 XDG/系统目录。
来源：<https://code.claude.com/docs/en/skills#available-string-substitutions>

【官方】Codex 的插件缓存路径是 `~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`，同样说明「安装目录按版本变化」，不能当数据目录。
来源：<https://developers.openai.com/plugins/build/plugins>

**数据分级建议**：

- `sessions/`、用户上传的图片、`settings.json` 里的 key：属于**不可再生数据**，放 `%LOCALAPPDATA%\comic-canvas`（Windows）或 `$XDG_DATA_HOME/comic-canvas`，不要放 `${CLAUDE_PLUGIN_DATA}`，因为卸载插件可能删除它。
- `node_modules`、Python 虚拟环境、OCR 模型缓存：属于**可重建依赖/缓存**，可以放 `${CLAUDE_PLUGIN_DATA}` 或系统缓存目录。

### 4.5 对 comic-canvas 的具体建议

建议用「一个环境变量 + 两套默认值」：

```text
COMIC_CANVAS_HOME（可选覆盖）
  Windows 默认：%LOCALAPPDATA%\comic-canvas
  macOS/Linux 默认：${XDG_DATA_HOME:-$HOME/.local/share}/comic-canvas

  <home>/sessions/          会话与图片（相当于现在的项目根 sessions/）
  <home>/settings.json      用户配置与 key（相当于现在的 settings.json）
  <home>/cache/             可删缓存
  <home>/logs/              日志
```

迁移时只读旧位置、首次启动时复制到新位置，并在报告里提示用户；不要删旧数据。

**Windows 上别用 `%APPDATA%` 放大文件**：`%APPDATA%` 是 Roaming，部分企业环境会同步到服务器，漫画会话动辄几百 MB 会拖慢登录。图片、模型、缓存放 `%LOCALAPPDATA%`。只有小体积、需要跨机器跟随用户的配置才放 `%APPDATA%`。

**文件名注意**：Windows 路径不能包含 `:`、`?`、`*` 等字符；会话名如果来自漫画标题，要做一次清洗。中文路径本身没问题，但脚本里用 `child_process` 调外部程序时，路径带空格要正确加引号。

---

## 5. 一个仓库同时放 skill 和完整应用

### 5.1 推荐布局

```text
comic-canvas/
├── package.json              # 应用本身可以是 npm 包（bin: comic-canvas）
├── server/                   # 完整应用：Node 7788 + Python 5009
├── public/                   # 原生前端
├── skills/
│   └── comic-canvas/
│       ├── SKILL.md          # 只写流程、命令、故障排查
│       ├── scripts/
│       │   └── run.mjs       # 启动器：找应用 → 启动 → 等健康检查
│       └── references/
│           └── setup.md      # 依赖安装说明
└── docs/
```

关键点：

1. **skill 负责「怎么用」，应用负责「真正干活」**。skill 目录里不要复制 `server/`、`public/`。
2. 启动器按顺序找应用：环境变量 `COMIC_CANVAS_ROOT` → 已安装的 npm 包（`comic-canvas` 的 `package.json`）→ 用户配置文件里的路径 → 当前工作目录（用户就在仓库根时）。
3. 找不到就明确报错，并给出两条路：`git clone <repo>` 后在仓库根运行，或 `npm i -g comic-canvas`。
4. 数据写到 4.5 的目录，不写 skill 目录。

**不要从 skill 目录向上找仓库**：skill 被复制到 `~/.claude/skills/<名>/` 后，它的父目录是 `skills`，再往上和仓库没有关系。向上找只适用于「用户就在仓库里、skill 还没被复制」的开发场景。

### 5.2 为什么不能只靠 skill 目录

【实测】用临时仓库跑 `npx skills add <本地仓库> --skill demo-skill -a codex -y`，安装结果只有：

```text
proj/.agents/skills/demo-skill/SKILL.md
proj/.agents/skills/demo-skill/scripts/hello.mjs
proj/skills-lock.json
```

仓库根的 `server/canvas.mjs`、`public/index.html` 都没有出现。也就是说：**skill 是「说明书 + 它自己的脚本」，不是整个应用**。这直接回答了 B。

### 5.3 真实开源例子

- **ChromeDevTools/chrome-devtools-mcp**：根目录是完整 npm 应用（`src/`、`server/`），另有 `skills/chrome-devtools/`、`skills/chrome-devtools-cli/`。skill 里不复制应用代码，而是要求安装全局包 `chrome-devtools-mcp`，用 `chrome-devtools` 命令操作；脚本路径用 skill 自身目录。
  来源：<https://github.com/ChromeDevTools/chrome-devtools-mcp>
  来源：<https://github.com/ChromeDevTools/chrome-devtools-mcp/tree/main/skills>
- **vercel-labs/agent-browser**：根目录是 Rust/Node 应用（`cli/`、`packages/`、`bin/`），`skills/agent-browser/` 只是发现入口；SKILL.md 让 agent 用已安装的 `agent-browser skills get core` 读取与版本匹配的详细说明。
  来源：<https://github.com/vercel-labs/agent-browser>
  来源：<https://github.com/vercel-labs/agent-browser/tree/main/skills/agent-browser>
- **browser-use/browser-use**：根目录是完整 Python 项目（`browser_use/`、`pyproject.toml`），`skills/` 下放使用说明；skill 通过已安装的 `browser-use` CLI 调应用，不把库复制进 skill。
  来源：<https://github.com/browser-use/browser-use>
  来源：<https://github.com/browser-use/browser-use/tree/main/skills>

### 5.4 安装后的路径解析（社区做法）

Claude Code 的官方变量 `${CLAUDE_SKILL_DIR}` 可以直接用在 SKILL.md 的 bash 命令里，指向 skill 自己所在目录，不受当前工作目录影响：

```markdown
Run `node "${CLAUDE_SKILL_DIR}/scripts/run.mjs"`
```

来源：<https://code.claude.com/docs/en/skills#available-string-substitutions>

Codex 没有同名变量，常见做法是让 agent 先读 SKILL.md 的路径（Codex 初始列表会带技能文件路径），或者在脚本里用 `import.meta.url` 推算自身位置：

```js
// scripts/run.mjs
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const skillDir = dirname(fileURLToPath(import.meta.url));
```

`import.meta.url` 只能可靠地找到**skill 自己的脚本**，不能用来找仓库。找应用要按 5.1 的顺序：先读 `COMIC_CANVAS_ROOT`，再用 `createRequire(import.meta.url).resolve('comic-canvas/package.json')` 找已安装的包，最后才尝试当前目录。如果用户是全局安装，`require.resolve` 可能找不到，可以再回退执行 `npm root -g` 拼出全局 `node_modules`。

一个最小示例：

```js
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

function findAppRoot() {
  if (process.env.COMIC_CANVAS_ROOT) return process.env.COMIC_CANVAS_ROOT;
  try {
    return dirname(require.resolve('comic-canvas/package.json'));
  } catch {}
  const cwd = process.cwd();
  if (existsSync(join(cwd, 'server', 'canvas.mjs'))) return cwd;
  return null;
}
```

这样复制到 `~/.claude/skills` 或 `.agents/skills` 后，只要用户装过 `comic-canvas` npm 包或设了环境变量，就能找到应用。

参考社区项目：browserbase 的 autobrowse 也强调「安装后的 skill 是只读的，训练产物写到当前工作目录，不写 `~/.claude/skills/`」。
来源：<https://github.com/browserbase/skills/blob/main/skills/autobrowse/SKILL.md>

### 5.5 「仓库根是应用 + skills/ 子目录」的真实例子

下面 4 个仓库都符合「根目录是可运行项目，同时提供 `skills/` 或 `.agents/skills/`」，但它们的路径策略不同：

| 仓库 | 应用在哪 | skill 在哪 | 安装后怎么找到应用 |
| --- | --- | --- | --- |
| [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | 根目录 npm 包（`src/`） | `skills/chrome-devtools/`、`skills/chrome-devtools-cli/` | 要求先全局 `npm i -g chrome-devtools-mcp`，skill 调 PATH 里的 `chrome-devtools` 命令；不回头找仓库 |
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | 根目录 Rust/Node 包 | `skills/agent-browser/` | 要求先 `npm install -g agent-browser`；skill 是一条「发现入口」，用 `agent-browser skills get core` 从已安装的 CLI 取与版本匹配的文档 |
| [browser-use/browser-use](https://github.com/browser-use/browser-use) | 根目录 Python 包（`browser_use/`） | `skills/browser-use/` 等 | 通过 `pip install browser-use` 安装的 `browser-use` CLI 调用；skill 不含库源码 |
| [mcpview/mcpview](https://github.com/mcpview/mcpview) | monorepo 里的 `packages/server` npm/JSR 包 | `packages/server/skills/SKILL.md` | skill 用 `npm install @mcpview/server`，之后按包名 import；不拼接仓库路径 |

共同点：**skill 目录里没有 `server/`、`public/` 这类应用代码**。应用通过包管理器安装到用户环境（全局命令或项目 `node_modules`），skill 只负责告诉 agent 怎么调用。

**为什么不能靠「相对路径回到仓库」**：

- 软链安装时，`~/.claude/skills/<名>` 指向规范副本，副本本身仍在 `.agents/skills/<名>`；从副本向上两级是项目根，看似能找到仓库。但这种布局只在「项目内安装 + 同仓库」时成立。
- `--copy` 或单 agent 默认复制时，`~/.claude/skills/<名>` 是一个真实目录，父目录是 `skills`，再往上是用户主目录，**和仓库没有任何关系**；相对路径会直接断掉。
- 全局 `-g` 安装时，目标在 `~/.agents/skills/<名>` 或 `~/.claude/skills/<名>`，更不可能找到原仓库。

所以正确顺序是：**已安装的包 → 环境变量 → 用户配置 → 当前目录**。相对路径只适用于「在仓库里开发、还没安装」的场景。

【社区】另一种常见变体：仓库根是应用，skill 放在**应用包内部的子目录**，例如 [mcpview/mcpview](https://github.com/mcpview/mcpview) 的 `packages/server/skills/`。这种布局下，skill 路径天然随包发布；`npx skills add` 仍按 `skills/` 容器发现，或按仓库根的 `skills.sh.json` / 插件清单声明。它适合 monorepo，不适合「根目录一个应用 + 一个 skill」的小项目。

【社区】[jsenv/core](https://github.com/jsenv/core) 用的是 `.agents/skills/<名>/`，SKILL.md 里直接写相对源码的链接（如 `../../src/dev/start_dev_server.js`）。这依赖「用户就在仓库里工作」，**不是**安装后的分发方案；官方 Codex 扫描时会跟随软链，但复制到用户目录后这些相对链接会断。

---

## 6. 针对本项目三个担心的直接回答

**A. Node/Python 依赖要不要单独装？**

要。skill 安装器不会装 Node 或 Python 运行时，也不会跑 `postinstall`。可以：

- 把 Node 应用做成 npm 包，skill 里用 `npx comic-canvas` 拉起；
- Python 部分做成独立包，用 `uvx` 拉起；
- 或者明确要求用户先装 Node 22+ 和项目自带的 Python 环境，并在 SKILL.md 的 `compatibility` 里写清。

不要静默下载几百 MB 的模型；缺依赖时停下来告诉用户装什么。

**B. 必须把所有代码放进 skill 目录吗？**

不。实测安装只复制 skill 目录。推荐把 skill 当「启动器 + 说明书」，应用留在仓库根或 npm 包里。这样仓库仍能独立开发、跑测试，skill 也能保持很小。代价是用户要么先 `git clone`，要么装 npm 包；单靠 `npx skills add` 不会得到完整应用。

**C. sessions 和 settings 放哪里？**

不放安装目录。用 `COMIC_CANVAS_HOME` 覆盖，默认 `%LOCALAPPDATA%\comic-canvas`（Windows）或 `$XDG_DATA_HOME/comic-canvas`（macOS/Linux）；配置可放 `%APPDATA%`，缓存放本地缓存目录。Claude Code 插件可以用官方 `${CLAUDE_PLUGIN_DATA}`，普通 skill 没有这个变量，按上面的规则自己选。

---

## 7. 落地清单（不改代码，只列步骤）

1. 在仓库根加 `package.json`，给应用一个 `bin`（例如 `comic-canvas`），声明 `engines.node >= 22`。
2. 把 `skills/manga-canvas-pipeline/` 重命名为 `skills/comic-canvas/`（或保留但确保 `name` 与目录同名），SKILL.md 只留流程和命令。
3. 加 `skills/comic-canvas/scripts/run.mjs`：解析应用位置 → 启动 7788/5009 → 轮询 `/health` → 失败时给出安装提示。
4. 服务端增加 `COMIC_CANVAS_HOME` 解析：默认用户数据目录，首次启动迁移旧 `sessions/`、`settings.json`。
5. 在 README 和 SKILL.md 写清两条安装路径：`npx skills add <repo> --skill comic-canvas` 与 `npm i -g comic-canvas`。
6. 用临时目录验证：安装后 `skills list` 能看到，`node scripts/run.mjs --doctor` 能找到应用或给出正确提示。
7. 发布前跑 `npx skills add <repo> --list`，确认只列出预期的 skill，不会把内部工具当成 skill。

---

## 参考链接汇总

- Agent Skills 规范：<https://agentskills.io/specification>
- vercel-labs/skills CLI：<https://github.com/vercel-labs/skills>
- 安装范围与方法：<https://github.com/vercel-labs/skills/blob/main/docs/commands.md>
- 各 agent 路径：<https://github.com/vercel-labs/skills/blob/main/docs/agents.md>
- 仓库发现规则：<https://github.com/vercel-labs/skills/blob/main/docs/creating-skills.md>
- Claude Code skills：<https://code.claude.com/docs/en/skills>
- Claude Code 插件数据目录：<https://code.claude.com/docs/en/plugins/components#path-variables-and-persistent-data>
- Claude Code 依赖安装限制：<https://code.claude.com/docs/en/plugins/loading#limits-on-the-dependency-install>
- Codex skills：<https://developers.openai.com/codex/skills>
- Codex 插件：<https://developers.openai.com/plugins/build/plugins>
- XDG：<https://specifications.freedesktop.org/basedir-spec/latest/>
- Windows Known Folder：<https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid>
- PEP 723 内联脚本元数据：<https://peps.python.org/pep-0723/>
- uv 工具与存储：<https://docs.astral.sh/uv/concepts/tools/>、<https://docs.astral.sh/uv/reference/storage/>
- npm npx：<https://docs.npmjs.com/cli/v11/commands/npx>

## 附：本次实测环境

- Windows，Node `v24.15.0`，npm `11.12.1`。
- `skills@1.9.0`，在 `%TEMP%` 下新建临时 git 仓库和临时项目目录测试。
- 测试只创建/删除临时目录，未改动 `I:\comic-canvas` 的项目代码；唯一新增文件是本文。

