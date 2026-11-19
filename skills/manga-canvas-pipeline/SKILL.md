---
name: manga-canvas-pipeline
description: 基于 comic-canvas 画布的漫画 OCR 校对与配音脚本技能：探活服务 → 整页 OCR → 用 /render 检查图逐页找漏框错框 → canvas CLI 增删框 → AI 理解图片写分镜 md（引用 @对话N）→ 生成 audio_scripts.json（角色声纹 + 对话列表）→ 豆包 audio-1.0 生成声纹与对话音频。用于漫画转有声、分镜拆解、OCR 校对补框。
metadata:
  short-description: 漫画画布 OCR 校对与配音脚本
---

# 漫画画布 OCR 校对与配音脚本

把 I:/comic-canvas/sessions/<会话>/ 里的漫画图片，经过「整页 OCR → 逐页检查图校对 →
修框 → AI 理解写 md → 配音脚本 → 声纹与对话音频」变成可配音的分镜数据。

## 零、总则（先读这一段）

目标是用**最短时间拿到可配音的分镜数据**，不是把每一页做到像素级完美。

- 三大步走完就交付：**OCR → scrub + view 两轮修框 → md / audio_scripts / characters**。
- 每页最多 **1 次 view 校验 + 1 次复验**；三页并行约 15 秒。
- 全程不逐框放大、不手工截图对比、不核对错别字（除非意思读反）。
- 用 CLI 一条命令完成一件事，不要多条命令拼同一个动作。
- 音频只抽查 2-3 条验证通路（API 收费），不要全量生成。
- 收尾自检：框校验超过 4 分钟，就是走弯路了。

出现下面任意一条，立即停下，回到「scrub 一次 + view 一次」的流程：

    - 建 _check 目录、下载 p3_full.jpg / p3_n0.jpg / p3_n1.jpg… 十几个局部图
    - 为同一个框反复调 rect 坐标，一次只挪十几像素
    - 删框后继续用旧编号删，删错行再来回补
    - 逐条核对 OCR 错别字（「财围」「夏然而止」这类）
    - 已经 PASS 过的页又重跑一次 view

## 一、架构与目录

**服务（设置与音频已合并进主服务，单端口 7788）**

    node I:/comic-canvas/server/canvas.mjs        # 画布 + 设置 + 音频管理，端口 7788
    I:/manga-image-translator/py310/python.exe I:/comic-canvas/server/ocr_service.py --port 5009 --use-gpu
    # 或者一键： I:/comic-canvas/start.bat

- 主服务 server/canvas.mjs（7788）：前后端一体。静态页面、会话管理、框 CRUD、
  SSE 广播、检查图 /render、任务队列（调 OCR 服务）、设置 API、音频管理 API。
  模型调用全部在 ocr_service.py，主服务不含 OCR 逻辑。
- OCR 服务 server/ocr_service.py（5009）：mask-column 算法。
  接口：/detect /ocr /detect/region /ocr/region /ocr/box /ocr/batch，/health 探活。
- 旧技能 manga-voice-pipeline（manga_cli.py + 5003 服务）已废弃，不再使用。

**项目目录**（一个会话 = 一个文件夹，一切操作都在这里）

    I:/comic-canvas/sessions/<会话>/
    ├── NNNNN.jpg                   页面图（1280 宽 jpg）
    ├── NNNNN.json                  选框与文字：regions 数组（box/text/prob/source）
    ├── NNNNN.md                    【本技能产出】AI 图片理解 + 分镜（@对话N 引用）
    ├── NNNNN_audio_scripts.json    【本技能产出】角色声纹 + 对话列表
    ├── characters.json             会话级角色档案（名字/外貌/声纹描述/音频引用）
    ├── voices/                     豆包生成的音频
    │   ├── <角色>.mp3              声纹（同时是该角色的最终参考音频）
    │   ├── <角色>_api_ref.mp3      API 参考音频（生成时传给豆包克隆音色）
    │   ├── <角色>_final_ref.mp3    最终参考音频（角色固定音色基准）
    │   └── dlg_*.mp3               生成的对话音频
    └── history/ backup/            画布自动记录的操作历史与快照

**主服务页面**（浏览器打开 http://127.0.0.1:7788/）

    /                画布主界面（图片平铺、框编辑、检查图预览 public/render.html）
    /settings.html   设置界面：OpenAI 模型（/models 检测下拉）、豆包 audio-1.0 key
                     （测试音频生成 / 测试参考音频）、manga-image-translator 路径探活
    /audio.html      音频管理：顶部角色面板（声纹描述、双轨参考音频、生成声纹、
                     试听）+ 下方对话列表（单条/批量生成对话音频）
    主页顶栏有「设置」「音频」按钮，dialog 内嵌打开，可全屏到独立窗口。
    key 等敏感配置存 I:/comic-canvas/settings.json（后端读写，前端脱敏显示）。

## 二、铁律

- **开始任何操作前先探活**：
  GET http://127.0.0.1:7788/api/sessions 与 GET http://127.0.0.1:5009/health。
  OCR 5009 未起时用上面的命令单独拉起；刚启动 /health 可能 20-40 秒才通。
- **写入只能走 CLI（canvas_cli.py），禁止直接改 sessions 下的 json**。
  CLI 走画布 HTTP 接口写入，才留历史、SSE 广播、前端实时刷新。
- **看图只能用 /render 检查图接口，禁止自己写 Pillow 脚本裁图。**
- **框的校验一律用 canvas_cli.py view，不要自己下载渲染图看**。
  view 已经把「拉整页预览图 + 读框数据 + 判断漏框/噪声框/空框」打包成一次调用，
  并直接给出可执行的修复命令。自己下载图片再看，等于把同一件事重复三遍：
  慢、且容易越看越细。整页一次看完就够，不要逐框放大。
  （view 超时/报错时原样重试一次；仍然失败才考虑手工看图，并在报告里说明。）
- **框只有新增（add）和删除（rm），没有编辑**。改文字 = rm 旧框 + add 新框。
- **md 与对话文本默认中文**。OCR 结果是英文/日文时，md 里翻译成中文保存；
  json 里 region.text 保持原样；除非用户明确指定目标语言。
- **错别字分级处理**：单个错别字（形近字误识，读者能看懂原意的）一律不管，
  跳过不改；只修「意思完全错误」或「文字逻辑错误」的框——词不存在、
  主谓宾断裂、语义反转这类。判断标准：读者读到这里会不会误解剧情。
  这样能把修字命令量从几十条压到几条。
- **OCR 结果只是草稿**。画布整页 OCR 只跑一遍检测，必然有噪声框和漏框；
  每页必须过一遍 view 校验后才算完成，但只过一遍。
- **框只要罩住文字就行，不要追求精确贴合**。padding 大小无所谓。
  边界轻微偏移但文字完整覆盖 = 通过。整页视角下看着正常就不要再放大。
- **禁止逐框放大核对**。v2/v3 实测：每页逐框放大要 30-60 次取图，
  占掉整个任务一半以上时间，而检出的问题用 view 一次就能全部列出来。
  只有 view 明确报了某个坐标的漏框、且整页图上确实看不清时，才允许对该点放大一次。
- **发现新角色必须立刻写入 characters.json**。只要对话或画面里出现
  一个之前没见过的角色（含未知角色），马上把 外貌描写 + 声线特征 写进
  会话级 characters.json，不允许留空。角色档案字段：
  name / appearance / voiceprint_desc / voiceprint_audio / api_ref_audio / final_ref_audio。

## 三、CLI（canvas_cli.py）

位置：I:/comic-canvas/skills/manga-canvas-pipeline/scripts/canvas_cli.py
Windows 控制台先执行 $env:PYTHONIOENCODING='utf-8'。

    python canvas_cli.py check                          # 探活两个服务
    python canvas_cli.py list <会话>                    # 所有页与框数
    python canvas_cli.py show <会话> <页>               # 看框：#编号 坐标 文字 来源
    python canvas_cli.py init <会话> <图片...>          # 新建会话（文件夹只放图片）
    python canvas_cli.py ocr <会话> [--pages 00003]     # 整页识别（走画布任务队列）
    python canvas_cli.py add <会话> <页> x1 y1 x2 y2 "文字"   # 新增框
    python canvas_cli.py rm <会话> <页> <编号...>       # 删除框，可一次给多个编号
    python canvas_cli.py rm <会话> <页> -1              # 删掉该页全部框（重来用）
    python canvas_cli.py scrub <会话> [页|all]          # 自动清空框/纯标点/单字噪声框
    python canvas_cli.py fix <会话> <页> --rm 3 --add 120,300,220,700 --text "文字"
                                                        # 原子改框：一次请求内删旧+加新，
                                                        # 避免删完索引错位导致反复试
    python canvas_cli.py md <会话> <页> [--out 路径]    # 生成分镜 md 骨架
    python canvas_cli.py audio <会话> <页> [--out 路径] # 生成 audio_scripts.json 骨架
    python canvas_cli.py voices <会话>                  # 查看角色声纹状态
    python canvas_cli.py view <会话> all                # 全页并行 AI 校验（推荐）
    python canvas_cli.py view <会话> 00003,00004        # 指定多页
    python canvas_cli.py view <会话> 00003              # 单页
                                                        # 输出 PASS/FAIL + 可直接执行的 rm/fix 命令
    python canvas_cli.py vp <会话> [角色名 ...]         # 生成角色声纹（缺省=全部角色）
    python canvas_cli.py dlg <会话> [--page NNNNN] [--ref 对话N]
                                                        # 生成对话音频（不传 --page/--ref = 全部）

编号规则：show 输出的 #N 从 0 开始 = json regions 数组下标 = md 里的 @对话N。

**编号稳定性**：add 只把新框追加到末尾，已有框编号一律不变；
rm 会让被删编号之后的框各前移一位，这是数组下标的必然结果。
所以连续删多个框时，要么一条命令给齐 `rm 会话 页 3 5 7`（内部从大到小删），
要么删一次就重新 show。改文字一律用 fix，删+加在同一次请求内完成。

## 四、检查图接口 /render（agent 看图专用）

    GET http://127.0.0.1:7788/render?session=<会话>&page=<页码>&...

一次请求返回合成 JPEG：灰度底图 + 参考线 + 坐标标注 + 识别框。
参考线延伸到图片左侧/顶部边距，坐标标在图外（左侧数字旋转90°），
agent 从刻度直接读出原始像素坐标，禁止自己裁图。

| 参数 | 说明 | 默认 |
|---|---|---|
| session / page | 会话名 / 页码 | 必填 |
| grid=1 | 画参考线 | 关 |
| minor / major | 细线 / 粗线间隔（粗线亮、带坐标数字） | 50 / 100 |
| labels=1 | 边距上标坐标 | 关 |
| margin | 左/上边距宽 | 64 |
| rect | 裁剪 x1,y1,x2,y2（单个；x2<=x1 直接报错） | 整页 |
| focus | 着重橙框（分号分隔多个），强调区域不影响输出范围 | 无 |
| src_mode + idx | include/exclude 框，idx 为 #编号（JSON 下标） | 全部 |
| no_text=1 / mono_boxes=1 | 框不写文字 / 统一红色 | 关 |
| lw | 框线宽 | 2 |
| gray=1 | 灰度（黑白漫画建议开） | 关 |
| q | 底图压缩质量（只压底图，参考线/文字始终清晰） | 35 |
| scale | 底图缩放 0.25~1（0.5 体积降 4 倍，坐标标注自动换算回原值） | 1 |
| zoom | 输出放大 | 1 |

两层压缩：q 只压底图（agent 只需要大致坐标），参考线、坐标文字、框标签在压缩后的
底图上高质量合成，调 q 不会把参考线压糊。实测 00003 整页：q70 946KB →
q35+scale0.5 165KB → 加 rect 27KB。

调参可视化页：http://127.0.0.1:7788/render.html （左调参数右出图，底部 URL 栏
就是给 agent 的最终接口地址）。

**框校验的默认动作就是 view 一次**，不要先手工下载渲染图。它自动拉整页预览图 +
框数据 json，交给 settings.json 配置的视觉模型，返回 PASS / FAIL 和
可直接执行的 rm/fix 命令。三页并行约 13-15 秒。

手工 /render 的适用场景只有两个：需要确认某个具体坐标的细节，或 view 报的
坐标与实际画面对不上。不要用它来做常规校验。

## 五、工作流程

### 第 5 步补充：audio_scripts.json 的分工

- 骨架由 CLI 生成：canvas_cli.py audio <会话> <页>
- performance 导演式提示词由 agent（AI）直接写文件，和写 md 一样，不需要走 CLI。
  读完该页 md 和框文本后，按本文档的 performance 写法逐条填进
  NNNNN_audio_scripts.json 的 performance 字段（tone 留空）。
- 声纹与对话音频生成走 CLI：vp（角色声纹）与 dlg（对话音频），
  等价于 /audio.html 的「生成声纹」「生成」「批量生成全部」按钮。

### 第 1 步：探活
    canvas_cli.py check
    并确认 sessions/<会话>/ 存在且含图片；没有会话用 init 创建。

### 第 2 步：整页 OCR
    canvas_cli.py ocr <会话>
    走画布任务队列逐页识别，结果写回每页 NNNNN.json。

### 第 3 步：框校验（一轮到底，最多两轮）

**标准做法：三条命令。**

    1) canvas_cli.py scrub <会话> all        # 先一键清掉空框/纯标点/单字噪声框
    2) canvas_cli.py view  <会话> all        # 全页并行 AI 校验，直接给出修复命令
    3) 把 view 输出的 [CMD: ...] 逐条执行      # 删掉噪声框 / 补上漏框
       再跑一次 view <会话> all，ALL PASS 就结束这一大步。

就这么两轮。不要 show 逐页对照、不要逐框放大、不要为 check 结果反复截图。

判断口径（view 已内置，这里只是说明）：

- 漏框：有需要念出来的文字没被任何框罩住 → 按 view 给的坐标 fix/add。
- 噪声框：框罩住的是瓦纹、划痕、网点、拟声字、招牌、页码 → rm 删掉。
- 空框：text 为空或纯标点 → rm 删掉（scrub 已能处理大部分）。
- 文字有错别字 → **不管**（见铁律：只有意思完全读错才修）。
- 框边界略偏但字完整罩住 → **通过**。

一页框做完的唯一标准：有正文的地方都有框，框里不是噪声，且 text 没有读取错误。

**明确禁止的两件事**（这是 v2/v3 各花掉 8-12 分钟的地方）：

    × 下载整页渲染图然后自己看成十上百个局部放大图
    × 一边删框一边用旧编号继续删（编号会重排，必用 fix 或重新 show）

### 第 4 步：写分镜 md（每页一个 NNNNN.md）
    canvas_cli.py md <会话> <页>   生成骨架（分镜占位 + 对话引用清单），agent 填充：
    - ## 分镜：按阅读顺序 **P1** **P2** ...，每镜写镜头（远景/中景/特写）、
      人物位置/动作/表情、关键道具，并在涉及台词处写 @对话N
    - @对话N 的 N = json regions 下标；骨架底部有「对话引用」清单可查
    - md 保存中文；OCR 原文非中文时翻译成中文
    - ## 校对：记录本页框检查结论（哪些核对无误、修了什么、依据）

    md 是 AI 直接写的文件，不走 CLI 之外的任何服务；一次写完一页，不要反复补丁。

### 第 5 步：配音脚本（每页一个 NNNNN_audio_scripts.json）
    canvas_cli.py audio <会话> <页>   生成骨架：
    {
      "characters": {
        "角色名": {
          "description": "外貌+性别+年龄感+声线特征（给豆包生成声纹用）",
          "voiceprint": "voices/<角色>.mp3",
          "ref_api":   "voices/<角色>_api_ref.mp3",
          "ref_final": "voices/<角色>_final_ref.mp3"
        }
      },
      "dialogues": [
        {"ref": "@对话5", "speaker": "喜织·狄狄", "page": "00003",
         "text": "中文台词",
         "tone": "",
         "performance": "男子（中青年男性，嗓音低沉）先吸了一口气，压着怒气开口，声音发紧；说到后半段语速放慢，句尾音量减弱，带疲惫感"}
      ]
    }
    角色从各页 md 抽离，汇总到会话级 characters.json（同名同一角色）。
    名字未知用「未知角色A」，后续拿到真名全局替换。
    【performance 字段写法（豆包 audio-1.0 官方范式）】
    - 每条对话默认用 performance（导演式提示词），不用 tone；
      tone 只在 performance 为空时兜底。
    - 写法核心：抽象情绪 → 可听行为。不要写「宿命感」「高级」，要写
      音色（低沉/沙哑/清亮）、气息（呼吸急促/带哭腔/吸气）、语速节奏
      （缓慢/拖沓/正常对话节奏）、停顿与副语言（停顿/轻笑/哽咽/句尾音量减弱）。
    - 长句里情绪有变化的，按时间顺序逐段写：「先…随后…最后…」。
    - 角色音色定义写在开头括号里：（中青年男性，嗓音低沉，沙哑）。
    - 参考官方示例：「男子2（中年男性，嗓音沙哑，成熟）平静无奈的语气说：……
      他的声音听起来充满了无力感，他缓缓说道：……」
    【重要】每发现一个新角色（含未知角色），立即写入 characters.json，
    字段：appearance（外貌）、voiceprint_desc（声线特征）必填，
    personality（性格，可为空字符串）。不允许 characters.json 留空角色。

    characters.json 是**扁平结构**（名字 → 档案），不要写成 {"characters": [...]}：

        {"旁白": {"name": "旁白", "appearance": "...", "voiceprint_desc": "...",
                  "personality": "", "voiceprint_audio": "", "api_ref_audio": "",
                  "final_ref_audio": ""}}

    写成数组结构会让 vp 命令报 "'list' object has no attribute 'get'"。

### 第 6 步：声纹与对话音频（豆包 audio-1.0）
    前置：/settings.html 里配好豆包 API key（只需配一次）。

    **全部用 CLI，不要开浏览器**（页面只是人工试听时用的）：

        canvas_cli.py vp  <会话>              # 生成全部角色声纹
        canvas_cli.py vp  <会话> 旁白 神·宗一  # 只生成指定角色
        canvas_cli.py dlg <会话> --page 00003 --ref 对话4   # 抽查一条
        canvas_cli.py dlg <会话>              # 生成全部（已生成的自动跳过）
        canvas_cli.py dlg <会话> --force       # 强制全部重生成（会花钱）

    dlg 默认跳过 voices/ 里已有的同名音频，避免重复计费；要重做才加 --force。
    canvas_cli.py voices <会话> 随时查看声纹状态。

### 第 7 步：验收
    - 每页：所有要念的文字都有框、文字正确（允许标点差异）
    - 每页：NNNNN.md（分镜 + @对话N）与 NNNNN_audio_scripts.json 齐全
    - 会话：characters.json 齐全、每角色有声纹描述与声纹音频
    - 全程操作在画布前端可见（写入走 CLI → SSE 实时刷新）

## 六、常见坑

- **本流程的实测基准**（3 页、32 框，v4 校准后的成绩）：
  探活 1.5s + OCR 12s + scrub 1.5s + view 两轮 50s + md/scripts 11s
  + 声纹 97s + 抽查 2 条音频 38s ≈ **4 分钟**。
  框校验合计 52 秒。若你的框校验超过 2 分钟，说明又在逐框放大或重复 view。

- **别手工看渲染图**。view 一次就能列出全部问题并给出可执行命令；
  自己下载图片逐个看是 v2/v3 耗时的一半来源。
- **删框后编号会重排**。要改框用 fix（一次请求内删+加），不要 rm 之后
  还按旧编号继续删。
- **scrub 只删确定是噪声的框**：空文本、纯标点、单字且低置信度。
  长文本即使 prob 很低也保留——OCR 置信度对长段落不可靠，误删正文会返工。
- **view 超时就原样重试一次**，不要因为一次超时改成手工看图。
- **三页以上用 view <会话> all**，内部并行，一页十几秒会压到总时长十几秒。

- 画布「整页 OCR」单遍检测会漏，只当草稿；漏框靠检查图逐页找，不要指望一次跑对。
- 检查图 q 只压底图，参考线/坐标文字始终清晰；scale=0.5 整页扫体积降 4 倍。
- rect 填 10,10,10,10 这种 x2<=x1 的值会直接报错（不会静默返回整页）。
- 检查图读坐标：刻度标注的就是原始像素值，不用自己换算；裁剪后左上角标 x/y 偏移。
- OCR 服务刚启动 /health 可能 20-40 秒后才通，别重复启动。
- Windows 控制台先设 $env:PYTHONIOENCODING='utf-8' 再跑 CLI。
- 不要修改主项目 server/、public/、sessions/ 数据；设置与音频页面已合并进主服务
  （tools/ 下的独立旧服务已移除）。
- 说话人判断靠画面证据（气泡尾巴、视线、张嘴），拿不准就写「未知角色A」。

