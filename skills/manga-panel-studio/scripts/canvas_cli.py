"""canvas_cli - 漫画分镜工作室 CLI（manga-panel-studio）

一切写入都通过画布 HTTP 接口（server/canvas.mjs 7788），留历史、SSE 广播、
前端实时刷新；禁止直接改 sessions/<会话>/ 下的 json。

框规则：只有新增（add）和删除（rm），没有编辑；改文字 = rm + add。

子命令：
    list   <会话>                              列出所有页和框数
    show   <会话> <页>                         打印该页所有框（#编号 坐标 文字）
    init   <会话> <图片...>                    新建会话（文件夹只放图片）
    ocr    <会话> [--pages NNNNN ...]          整页识别（走画布任务队列）
    plan   <会话>                              开工计划：页数/目录/实时地址/步骤
    next   <会话>                              流水线取页：最早一页待处理的页号
    add    <会话> <页> x1 y1 x2 y2 文字        新增框
    rm     <会话> <页> <编号>                  删除框
    voices <会话>                              查看/初始化会话角色声纹状态
    view   <会话> <页> [--prompt 补充提示词] [--out 路径]
                                               AI 视觉校验：预览图+框数据一次给出 PASS/FAIL 与修复方向
    ai-audio <会话> [--pages NNNNN ...]        AI 填写 performance 音频提示词（豆包导演式）
    vp     <会话> [角色名 ...]                  生成角色声纹（缺省=全部角色）
    dlg    <会话> [--page NNNNN] [--ref 对话N] [--all]
                                               生成对话音频（--all=本会话全部）
    check                                     探活两个服务
    doctor                                    启动检查：配置有缺项才拉起服务并打开设置页
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.parse import urlencode
from concurrent.futures import ThreadPoolExecutor
import re

import requests

DEFAULT_BASE = "http://127.0.0.1:7788"
OCR_BASE = "http://127.0.0.1:5009"
# 路径与端口统一从 settings.json 读，不再写死盘符。
# settings.json 位置：环境变量 STUDIO_SETTINGS_FILE > ~/.manga-panel-studio/settings.json
# > 项目根 settings.json（旧位置，向后兼容）。
# 数据目录：环境变量 STUDIO_DATA_DIR > settings.canvas.dataDir > ~/.manga-panel-studio
# 默认值与 Node 侧（tools_helpers.js 的 HOME）保持一致，否则同一份 settings.json
# 会被两边读成两个不同目录，sessions 看起来“凭空消失”。
_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent.parent.parent          # skills/<name>/scripts/ 上三级 = 仓库根
def _default_settings_file():
    home = Path(os.environ.get("STUDIO_DATA_DIR") or (Path.home() / ".manga-panel-studio"))
    candidates = [home / "settings.json", _REPO / "settings.json"]
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]

_SETTINGS_FILE = Path(os.environ.get("STUDIO_SETTINGS_FILE") or _default_settings_file())

def _read_cfg():
    try:
        return json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

_cfg = _read_cfg()
_canvas = _cfg.get("canvas") or {}
_home = Path(os.environ.get("STUDIO_DATA_DIR") or _canvas.get("dataDir")
             or (Path.home() / ".manga-panel-studio"))
ROOT = _REPO
SESSIONS_ROOT = _home / "sessions"
DEFAULT_BASE = os.environ.get("STUDIO_CANVAS_BASE") or (_canvas.get("canvasBaseUrl") or DEFAULT_BASE)
OCR_BASE = os.environ.get("STUDIO_OCR_BASE") or (_canvas.get("ocrBaseUrl") or OCR_BASE)
LOG_DIR = _home / "logs"

# Python 解释器：settings.translator.projectRoot 推导，回退 PATH
def _find_ocr_py():
    mt = os.environ.get("MT_ROOT") or (_cfg.get("translator") or {}).get("projectRoot") or ""
    if mt:
        for sub in ("py310/python.exe", "venv/Scripts/python.exe", ".venv/Scripts/python.exe"):
            c = Path(mt) / sub
            if c.exists():
                return c
    return Path("python")

OCR_PY = _find_ocr_py()

VIEW_SYSTEM_PROMPT = (
    "你是漫画 OCR 校对助手。用户给你一张校对预览图（灰度底图+红色标记框+坐标刻度）"
    "和该页的框数据 json（含每个框的 text 与 prob 置信度）。只判断三件事："
    "1) 漏框：有需要念出来的文字没被任何红框罩住；"
    "2) 噪声框：框罩住的是瓦纹、划痕、网点、拟声字、招牌、页码这类非正文内容；"
    "3) 空框：text 为空或是纯标点、prob 明显偏低（<0.5）且画面无对应正文。"
    "框只要完整罩住文字就算通过：不要挑剔边界贴合度，不要核对错别字，"
    "不要建议改文字内容。输出格式：第一行 PASS 或 FAIL；PASS 就一句话说明；"
    "FAIL 则逐条列出 #编号 + 位置 + 问题类型（漏框/噪声框/空框），"
    "并在该行末尾给出可直接执行的修复命令：删框写 "
    "[CMD: rm <会话> <页> <编号>]，补框写 [CMD: fix <会话> <页> --add x1,y1,x2,y2 --text \"文字\"]。"
    "不要输出其他内容。"
)


def api(base, method, path, **kw):
    url = base.rstrip("/") + path
    try:
        r = requests.request(method, url, timeout=60, **kw)
    except requests.ConnectionError:
        sys.exit(f"服务不可达: {url} —— 先启动画布(server/canvas.mjs, 7788)")
    if r.status_code >= 400:
        raise SystemExit(f"画布返回 {r.status_code}: {r.text[:300]}")
    try:
        return r.json()
    except ValueError:
        return r.text


def check_services() -> None:
    for name, url in (("画布 7788", DEFAULT_BASE + "/api/sessions"),
                      ("OCR 5009", OCR_BASE + "/health")):
        try:
            r = requests.get(url, timeout=5)
            print(f"  {name}: OK ({r.status_code})")
        except Exception as e:
            print(f"  {name}: 不可用 —— {e}")
    mt = os.environ.get("MT_ROOT") or (_cfg.get("translator") or {}).get("projectRoot") or "<MT目录>"
    print(f"    画布: node {ROOT}/server/canvas.mjs")
    print(f"    OCR:  {mt}/py310/python.exe {ROOT}/server/ocr_service.py --port 5009 --use-gpu")


def _alive(url, timeout=3):
    try:
        return requests.get(url, timeout=timeout).status_code < 500
    except Exception:
        return False


def _wait_until(url, seconds, label):
    """等到 url 通，最多 seconds 秒；返回是否通。"""
    t0 = time.time()
    while time.time() - t0 < seconds:
        if _alive(url, timeout=3):
            print(f"  {label}: 已启动（{int(time.time() - t0)} 秒）")
            return True
        time.sleep(2)
    print(f"  {label}: {seconds} 秒内没起来，看日志 {LOG_DIR}")
    return False


def _spawn(cmd, log_name):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = open(LOG_DIR / log_name, "ab")
    flags = 0
    if os.name == "nt":
        flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    print("  启动：" + " ".join(str(c) for c in cmd))
    subprocess.Popen([str(c) for c in cmd], cwd=str(ROOT), stdout=log, stderr=log,
                     stdin=subprocess.DEVNULL, creationflags=flags, close_fds=True)


def missing_settings(st):
    """返回没填的配置项（中文名）。key 只看到脱敏值也算已填。"""
    miss = []
    oa = st.get("openai") or {}
    if not (oa.get("baseUrl") or "").strip():
        miss.append("OpenAI Base URL")
    if not (oa.get("apiKey") or "").strip():
        miss.append("OpenAI API Key")
    if not (oa.get("model") or "").strip():
        miss.append("OpenAI 模型")
    db = st.get("doubao") or {}
    if not (db.get("apiKey") or "").strip():
        miss.append("豆包 API Key")
    tr = st.get("translator") or {}
    if not (tr.get("baseUrl") or "").strip():
        miss.append("OCR 服务地址")
    return miss


def read_settings_file():
    """直接读 settings.json，不依赖服务是否在跑。走统一入口 _SETTINGS_FILE。"""
    path = _SETTINGS_FILE
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def cmd_doctor(args):
    """启动时只做两件事：查配置是否存在；缺配置才拉起服务并打开设置页。"""
    miss = missing_settings(read_settings_file())
    if not miss:
        print("配置已存在，不需要任何启动动作")
        return 0

    print("配置还没填：" + "、".join(miss))
    url = DEFAULT_BASE + "/settings.html"

    if _alive(DEFAULT_BASE + "/api/sessions"):
        print("  画布服务已在运行，直接打开设置页")
    else:
        print("  先启动画布服务…")
        _spawn([shutil.which("node") or "node", "server/canvas.mjs"], "canvas.log")
        if not _wait_until(DEFAULT_BASE + "/api/sessions", 25, "画布服务"):
            raise SystemExit("画布服务没起来，看 .tmp/canvas.log")

    print("  打开设置页：" + url)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception as e:
            print("  浏览器没打开（%s），请手动打开上面的地址" % e)
    return 2


def get_page(base, session, page):
    return api(base, "GET", f"/api/session/{session}/page/{page}")


def put_regions(base, session, page, regions, summary, box=None, op="box-edit", boxes=None):
    return api(base, "PUT", f"/api/session/{session}/page/{page}",
        json={"regions": regions, "by": "manga-panel-studio-cli",
                     "op": op, "summary": summary, "force": True,
                     "box": box, "boxes": boxes})


def done_pages(base, session):
    """返回 (已完成页, 识别中页, 排队数)：判断哪些页 OCR 好了可以立刻往下做。"""
    st = api(base, "GET", "/api/jobs")
    done, running = set(), set()
    for j in st.get("jobs") or []:
        if j.get("session") != session:
            continue
        if j.get("status") == "done":
            done.add(j.get("page"))
        elif j.get("status") == "running":
            running.add(j.get("page"))
    return done, running


def cmd_check(args):
    check_services()


def normalize_page(p):
    """页码归一化成 5 位（NNNNN）：'1' -> '00001'，'0001' -> '00001'。
    服务端页码 = 文件名去扩展名，原样返回；这里只处理手写页码位数不齐的情况。"""
    s = str(p).strip()
    return s.zfill(5) if s.isdigit() else s


def record_pipeline(base, session, kind, page=None, pages=None, remaining=None):
    """把流水线动作（排队 / 取页）写进画布历史，UI 历史面板可见。
    失败不阻塞主流程：历史只是可视化，记录不上就算了。"""
    try:
        api(base, "POST", f"/api/session/{session}/pipeline",
            json={"kind": kind, "page": page, "pages": pages, "remaining": remaining})
    except Exception:
        pass


def cmd_list(args):
    d = api(args.base, "GET", f"/api/session/{args.session}")
    for p in d["pages"]:
        print(f"  {p['page']}  {p['width']}x{p['height']}  {len(p['regions'])} 框")
    print(f"共 {len(d['pages'])} 页")


def cmd_show(args):
    page = normalize_page(args.page)
    p = get_page(args.base, args.session, page)
    print(f"{page}  {p['width']}x{p['height']}  {len(p['regions'])} 框")
    for i, r in enumerate(p["regions"]):
        box = ",".join(str(int(v)) for v in r["box"])
        print(f"  #{i:<2} [{box}] {r.get('text','')!r}  ({r.get('source','')})")


def cmd_init(args):
    api(args.base, "POST", "/api/sessions", json={"name": args.session})
    imgs = sorted(Path(p) for p in args.images)
    missing = [str(p) for p in imgs if not p.exists()]
    if missing:
        raise SystemExit("找不到图片: " + ", ".join(missing))
    # 页码归一化：一律重命名为 5 位（NNNNN），按文件名排序后顺序编号。
    # 页码格式不统一会让校验/历史/脚本里出现 0001 和 00003 并存的混乱。
    renamed = []
    for i, p in enumerate(imgs, 1):
        ext = p.suffix.lower() if p.suffix.lower() in ('.jpg', '.jpeg', '.png', '.webp') else '.jpg'
        target = Path('%05d%s' % (i, ext))
        if target in renamed:
            raise SystemExit("重名冲突: " + str(target))
        renamed.append(target)
    files = []
    for p, t in zip(imgs, renamed):
        if p.name != t.name:
            print(f"  页码归一化: {p.name} -> {t.name}")
        files.append({"name": t.name,
                      "data": "data:image/jpeg;base64," + base64.b64encode(p.read_bytes()).decode()})
    print(api(args.base, "POST", f"/api/session/{args.session}/upload", json={"files": files}))
    print(f"sessions/{args.session} 已建立（只含 {len(files)} 张图）")


def cmd_ocr(args):
    d = api(args.base, "GET", f"/api/session/{args.session}")
    pages = [p["page"] for p in d["pages"]]
    if args.pages:
        wanted = [normalize_page(x) for x in args.pages]
        pages = [p for p in pages if p in wanted]
    if not pages:
        raise SystemExit("没有要识别的页")
    for pg in pages:
        job = api(args.base, "POST", f"/api/session/{args.session}/job",
                  json={"page": pg, "mode": "ocr-page"})
        print(f"  排队 {pg}: {job.get('id')}")
    record_pipeline(args.base, args.session, "pipeline-ocr", pages=pages)
    print("")
    print("已排入 %d 页，后台识别中。不要在这里干等。" % len(pages))
    print("  打开 http://127.0.0.1:7788/?s=%s 可以实时看进度。" % args.session)
    print("  下一步：python canvas_cli.py next %s（每页一好就取走处理）" % args.session)


def cmd_plan(args):
    """开工计划：一次打印会话、页数、数据目录、实时地址、步骤和节奏。
    agent 把这段直接转给用户，就不会漏掉进度网址。"""
    sdir = SESSIONS_ROOT / args.session
    if not sdir.exists():
        raise SystemExit("会话不存在: %s\n先 init 建会话，或检查会话名有没有写错" % sdir)
    pages = sorted(p.stem for p in sdir.iterdir()
                   if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")
                   and not p.name.startswith("."))
    total = len(pages)
    with_boxes = 0
    done_md = 0
    for pg in pages:
        try:
            meta = json.loads((sdir / (pg + ".json")).read_text(encoding="utf-8"))
            if meta.get("regions"):
                with_boxes += 1
        except Exception:
            pass
        if (sdir / (pg + ".md")).exists():
            done_md += 1
    print("会话：%s" % args.session)
    print("页数：%d 页（已出框 %d，已写 md %d）" % (total, with_boxes, done_md))
    print("数据目录：%s" % sdir)
    print("实时地址：%s/?s=%s" % (args.base.rstrip("/"), args.session))
    print("")
    print("流程：")
    print("  1. ocr 排队（一次全排，立刻返回，不等识别完成）")
    print("  2. next 逐页取 → 校验修框 → 写 md + audio_scripts")
    print("  3. 全部做完再跑 check-characters / check-audio 自检")
    print("")
    print("节奏：每页约 20-40 秒，边做边报「已完成 N/%d」。" % total)


def cmd_next(args):
    """流水线取页：打印最早一页「已 OCR 完但还没写 md」的页号。
    没有可处理的页时退出码 1，调用方据此决定是等待还是收尾。"""
    sdir = SESSIONS_ROOT / args.session
    if not sdir.exists():
        raise SystemExit("会话不存在: " + str(sdir))
    done, running = done_pages(args.base, args.session)
    pages = sorted(p.stem for p in sdir.iterdir()
                   if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")
                   and not p.name.startswith("."))
    def has_boxes(pg):
        """这页是否已经 OCR 出框。以页面 JSON 为准，不依赖任务队列
        （服务重启后 /api/jobs 只保留最近若干条，靠它判断会误报）。"""
        try:
            meta = json.loads((sdir / (pg + ".json")).read_text(encoding="utf-8"))
            return len(meta.get("regions") or []) > 0
        except Exception:
            return False

    ready = [pg for pg in pages
             if has_boxes(pg) and not (sdir / (pg + ".md")).exists()]
    if not ready:
        with_boxes = [p for p in pages if has_boxes(p)]
        left = [p for p in pages if not has_boxes(p)]
        print("暂时没有可处理的页（已识别 %d/%d" % (len(with_boxes), len(pages))
              + (", 识别中 %d" % len(running) if running else "")
              + (", 未识别 %d" % len(left) if left else "") + "）")
        raise SystemExit(1)
    record_pipeline(args.base, args.session, "pipeline-next", page=ready[0],
                    remaining=len(ready) - 1)
    print(ready[0])


def cmd_add(args):
    page = normalize_page(args.page)
    p = get_page(args.base, args.session, page)
    regions = p["regions"]
    regions.append({"box": [args.box[0], args.box[1], args.box[2], args.box[3]],
                    "text": args.text, "translation": "", "lang": "zh",
                    "prob": 1.0, "angle": 0, "source": "manual"})
    put_regions(args.base, args.session, page, regions,
                f"补框：{args.text[:16]}", box=args.box, op="box-add")
    print(f"新增 1 框，现有 {len(regions)} 框")
    print(f"  新框编号 = #{len(regions) - 1}（追加在末尾，已有框编号不变）")


def cmd_rm(args):
    """删除框。编号 = 该页 regions 数组下标；删掉一个，其后编号会前移一位。"""
    page = normalize_page(args.page)
    p = get_page(args.base, args.session, page)
    regions = p["regions"]
    idxs = args.index
    if len(idxs) == 1 and idxs[0] < 0:
        idxs = list(range(len(regions)))
    if not idxs:
        raise SystemExit("要删哪些框？给 #编号（可多个），或给 -1 表示全部")
    bad = [i for i in idxs if not 0 <= i < len(regions)]
    if bad:
        raise SystemExit(f"没有 {bad}（共 {len(regions)} 框）")
    dropped = [regions[i] for i in idxs]
    for i in sorted(idxs, reverse=True):
        regions.pop(i)
    summary = f"删框 {len(idxs)} 个：" + "、".join(
        (x.get('text') or '<空>')[:8] for x in dropped[:3])
    # 把删掉的框坐标一起记下来：历史卡片用页面原图现场画红框，不需要另存图片
    put_regions(args.base, args.session, page, regions, summary, op="box-del",
                box=dropped[0].get("box") if len(dropped) == 1 else None,
                boxes=[x.get("box") for x in dropped])
    print(f"已删 {sorted(idxs)}，剩 {len(regions)} 框")
    print("  注意：被删编号之后的框编号各前移一位；要改文字用 fix，一次完成删+加")
    for i, r in enumerate(regions):
        print(f"  #{i} [{','.join(str(int(v)) for v in r['box'])}] "
              f"{(r.get('text') or '')[:24]!r}")


def cmd_scrub(args):
    """清掉 OCR 噪声框：纯标点、空文本、低置信度，一键删除并打印剩余框。"""
    raw = str(args.page).strip()
    if raw.lower() == "all":
        d = api(args.base, "GET", f"/api/session/{args.session}")
        pages = [x["page"] for x in d["pages"]]
    else:
        pages = [x.strip() for x in raw.split(",") if x.strip()]
    pages = [normalize_page(x) for x in pages]
    for page in pages:
        scrub_page(args, page)


def scrub_page(args, page):
    p = get_page(args.base, args.session, page)
    regions = p["regions"]
    noise, keep = [], []
    for i, r in enumerate(regions):
        t = (r.get("text") or "").strip()
        prob = float(r.get("prob") or 0)
        alnum = sum(1 for ch in t if ch.isalnum())
        # 只删「确定不是正文」的框：空文本 / 纯标点 / 极短且低置信度。
        # 长文本即使 prob 低也绝不删——OCR 的 prob 对长段落并不可靠。
        is_noise = (alnum == 0) or (alnum <= 1 and prob < 0.5)
        (noise if is_noise else keep).append((i, r))
    if not noise:
        print(f"{page}: 没有可自动清理的噪声框（共 {len(regions)} 框）")
        return
    put_regions(args.base, args.session, page, [r for _, r in keep],
                f"清理噪声框 {len(noise)} 个", op="box-del")
    print(f"{page}: 删掉 {len(noise)} 个噪声框，剩 {len(keep)} 框")
    for i, r in noise:
        print(f"  删 #{i} {r.get('text')!r} prob={float(r.get('prob') or 0):.2f}")
    for i, (_, r) in enumerate(keep):
        print(f"  #{i} [{','.join(str(int(v)) for v in r['box'])}] "
              f"{(r.get('text') or '')[:24]!r}")


def cmd_fix(args):
    """原子改框：一次请求内 删旧框 + 加新框，避免删后索引错位。
    --rm N[,M...]  --add x1,y1,x2,y2  --text "文字" """
    page = normalize_page(args.page)
    p = get_page(args.base, args.session, page)
    regions = p["regions"]
    idxs = [int(x) for x in str(args.rm).split(",") if x.strip()] if args.rm else []
    bad = [i for i in idxs if not 0 <= i < len(regions)]
    if bad:
        raise SystemExit(f"没有 {bad}（共 {len(regions)} 框）")
    dropped = [regions[i] for i in idxs]
    for i in sorted(idxs, reverse=True):
        regions.pop(i)
    if args.add:
        x1, y1, x2, y2 = args.add
        regions.append({"box": [x1, y1, x2, y2], "text": args.text or "",
                        "translation": "", "lang": "zh", "prob": 1.0,
                        "angle": 0, "source": "manual"})
    put_regions(args.base, args.session, page, regions,
                f"改框 rm={idxs} add={args.add}", op="box-edit")
    print(f"已改：删 {len(idxs)} 框，加 {1 if args.add else 0} 框，现 {len(regions)} 框")
    for i, r in enumerate(regions):
        print(f"  #{i} [{','.join(str(int(v)) for v in r['box'])}] "
              f"{(r.get('text') or '')[:24]!r}")


def cmd_voices(args):
    sdir = SESSIONS_ROOT / args.session
    vdir = sdir / "voices"
    vdir.mkdir(exist_ok=True)
    ch_path = sdir / "characters.json"
    chars = json.loads(ch_path.read_text(encoding="utf-8")) if ch_path.exists() else {}
    if not chars:
        print(f"{ch_path} 不存在或为空；先完成各页 md 后汇总角色到此处")
        return
    for name, c in chars.items():
        # 字段名兼容：服务端写的是 voiceprint_audio/final_ref_audio，
        # 早期骨架里写的是 voiceprint/ref_final。以磁盘上真实文件为准。
        vp = (c.get("voiceprint_audio") or c.get("voiceprint") or "")
        api_ref = (c.get("api_ref_audio") or c.get("ref_api") or "")
        fin = (c.get("final_ref_audio") or c.get("ref_final") or "")
        has_vp = bool(vp) and (vdir / Path(vp).name).exists()
        if not has_vp:
            guess = vdir / (name + ".mp3")
            has_vp = guess.exists()
        print(f"  {name}: 声纹 {'OK' if has_vp else '缺'}"
              f"  api_ref={'有' if api_ref else '无'}"
              f"  final_ref={'有' if fin else '无'}")

# ---------- AI 视觉校验 ----------

def chat_with_vision(base_url, api_key, model, system_prompt, user_text, image_jpeg_bytes):
    url = base_url.rstrip("/") + "/chat/completions"
    r = requests.post(
        url, timeout=180,
        headers={"Authorization": "Bearer " + api_key, "User-Agent": "node"},
        json={
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {
                        "url": "data:image/jpeg;base64,"
                               + base64.b64encode(image_jpeg_bytes).decode()}},
                ]},
            ],
        },
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def load_settings():
        return json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))


def cmd_view(args):
    """AI 视觉校验。page 可写单页，也可写 'all' 或逗号分隔的多页。"""
    raw = str(args.page).strip()
    if raw.lower() == "all":
        d = api(args.base, "GET", f"/api/session/{args.session}")
        pages = [p["page"] for p in d["pages"]]
    else:
        pages = [normalize_page(x) for x in raw.split(",") if x.strip()]
    if not pages:
        raise SystemExit("没有要校验的页")

    st = load_settings().get("openai", {})

    # 每次 view 都把「预览图 + 提示词 + 模型参数 + 模型回答」写进画布历史，
    # 这样前端历史卡片里能看到 AI 当时到底看了什么、说了什么。
    def record(page, preview_bytes, user_text, answer, ok, ms, err=None, regions=None):
        try:
            api(args.base, "POST", f"/api/session/{args.session}/check", json={
                "page": page,
                "by": "cli-view",
                "previewB64": base64.b64encode(preview_bytes).decode() if preview_bytes else None,
                "answer": answer,
                "pass": bool(ok),
                "model": st.get("model", ""),
                "error": err,
                "ms": ms,
                "regions": len(regions or []),
                "regionsData": regions,
                "prompt": user_text,
                "systemPrompt": VIEW_SYSTEM_PROMPT,
                "params": {
                    "baseUrl": st.get("baseUrl", ""),
                    "model": st.get("model", ""),
                    "temperature": None,
                    "extra": {"prompt": args.prompt or ""},
                },
                "render": {"grid": 1, "labels": 1, "gray": 1, "q": 35, "scale": 0.5},
            })
        except SystemExit as e:
            print(f"  [警告] 历史记录没写进去：{e}", file=sys.stderr)
        except Exception as e:
            print(f"  [警告] 历史记录没写进去：{type(e).__name__}: {e}", file=sys.stderr)

    def check(page):
        t0 = time.time()
        params = {"session": args.session, "page": page, "grid": "1", "labels": "1",
                  "gray": "1", "q": "35", "scale": "0.5"}
        r = requests.get(args.base.rstrip("/") + "/render?" + urlencode(params), timeout=60)
        if r.status_code >= 400:
            record(page, None, "", f"PREVIEW_FAIL {r.text[:200]}", False,
                   int((time.time() - t0) * 1000), err=r.text[:200])
            return page, f"PREVIEW_FAIL {r.text[:200]}", False
        p = get_page(args.base, args.session, page)
        regions = [{"i": i, "box": x.get("box"), "text": x.get("text") or "",
                    "prob": round(float(x.get("prob") or 0), 3)}
                   for i, x in enumerate(p.get("regions", []))]
        payload = {"page": page, "width": p.get("width"), "height": p.get("height"),
                   "regions": regions}
        user_text = (f"请校对会话 {args.session} 第 {page} 页。预览图红框上的 #N 就是下表 i。"
                     "框数据：\n" + json.dumps(payload, ensure_ascii=False))
        if args.prompt:
            user_text += "\n\n用户补充要求：" + args.prompt
        last = ""
        for attempt in (1, 2):
            try:
                answer = chat_with_vision(st.get("baseUrl", ""), st.get("apiKey", ""),
                                          st.get("model", ""), VIEW_SYSTEM_PROMPT,
                                          user_text, r.content)
                ok = answer.strip().upper().startswith("PASS")
                record(page, r.content, user_text, answer.strip(), ok,
                       int((time.time() - t0) * 1000), regions=regions)
                return page, answer.strip(), ok
            except Exception as e:
                last = f"{type(e).__name__}: {e}"
        record(page, r.content, user_text, f"CHECK_FAIL {last}", False,
               int((time.time() - t0) * 1000), err=last, regions=regions)
        return page, f"CHECK_FAIL {last}", False

    with ThreadPoolExecutor(max_workers=min(4, len(pages))) as pool:
        results = list(pool.map(check, pages))

    all_pass = True
    for page, body, ok in results:
        if not ok:
            all_pass = False
        print(f"=== {page} ===")
        print(body)
    print("SUMMARY: " + ("ALL PASS" if all_pass else "HAS ISSUES"))
    if args.out:
        Path(args.out).write_text(
            "\n\n".join(f"=== {p} ===\n{b}" for p, b, _ in results), encoding="utf-8")


# ---------- 音频生成（声纹 / 对话） ----------

def cmd_vp(args):
    """生成角色声纹，等价前端「生成声纹」按钮。"""
    sdir = SESSIONS_ROOT / args.session
    ch_path = sdir / "characters.json"
    if not ch_path.exists():
        raise SystemExit(f"{ch_path} 不存在；先完成角色档案（AI 直接写该文件）")
    chars = json.loads(ch_path.read_text(encoding="utf-8"))
    names = args.names or list(chars.keys())
    if not names:
        raise SystemExit("characters.json 里没有角色")
    print(f"准备生成 {len(names)} 个角色的声纹：{', '.join(names)}", flush=True)
    done = failed = 0
    for n, name in enumerate(names, 1):
        if name not in chars:
            print(f"  [{n}/{len(names)}] 跳过 {name}: 不在 characters.json", flush=True)
            continue
        desc = chars[name].get("voiceprint_desc") or ""
        if not desc:
            print(f"  [{n}/{len(names)}] 跳过 {name}: voiceprint_desc 为空，先补档案", flush=True)
            continue
        print(f"  [{n}/{len(names)}] 生成 {name} ...", end="", flush=True)
        r = api(args.base, "POST", "/api/audio/generate",
                json={"session": args.session, "name": name, "purpose": "voiceprint"})
        if r.get("ok"):
            done += 1
            print(f" OK {r.get('duration','')}s"
                  + (f"  warning={r['warning']}" if r.get("warning") else ""), flush=True)
        else:
            failed += 1
            print(f" 失败 {r.get('message','')}", flush=True)
    print(f"完成：成功 {done} 个" + (f"，失败 {failed} 个" if failed else ""), flush=True)


def load_scripts(session):
    """读会话下全部 *_audio_scripts.json（保持文件顺序）。"""
    sdir = SESSIONS_ROOT / session
    out = []
    for f in sorted(sdir.glob("*_audio_scripts.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        out.append((f, data))
    return out


def _derived_ref(i):
    """AI 手写的脚本没有 ref 字段时，用对话顺序兜底。"""
    return "@对话" + str(i)


def load_characters(session):
    """读会话级角色档案（扁平结构：名字 -> 档案）。"""
    ch = SESSIONS_ROOT / session / "characters.json"
    if not ch.exists():
        return {}
    try:
        return json.loads(ch.read_text(encoding="utf-8"))
    except Exception:
        return {}


def has_ref_audio(session, speaker):
    """角色是否已有可用的参考音频文件。"""
    c = load_characters(session).get(speaker) or {}
    vdir = SESSIONS_ROOT / session / "voices"
    for key in ("final_ref_audio", "api_ref_audio", "voiceprint_audio"):
        n = (c.get(key) or "").strip()
        if n and (vdir / Path(n).name).exists():
            return True
    return (vdir / (speaker + ".mp3")).exists()


def gen_one_dialogue(base, session, page, d):
    # 没有 ref 字段的脚本，用顺序号兜底（输出文件名需要它）
    if not d.get("ref"):
        d["ref"] = _derived_ref(d.get("_idx", 0))
    speaker = d.get("speaker") or ""
    perf = d.get("performance") or ""
    # 角色还没有任何参考音频时，把 characters.json 里的声纹描述
    # 作为音色说明拼进 performance —— 服务端只在生成声纹时用它，
    # 对话生成不会自动带上，所以在这里补。
    if perf and speaker and not has_ref_audio(session, speaker):
        desc = ((load_characters(session).get(speaker) or {}).get("voiceprint_desc") or "").strip()
        if desc and desc not in perf:
            perf = desc + perf
    r = api(base, "POST", "/api/audio/generate", json={
        "session": session, "name": speaker, "purpose": "dialogue",
        "text": d.get("text") or "", "tone": d.get("tone") or "",
        "performance": perf,
        "ref": d.get("ref") or "", "page": page,
    })
    tag = f"{page} {d.get('ref','')} {speaker}"
    if r.get("ok"):
        print(f"  {tag}: OK  {r.get('duration','')}s"
              + (f"  warning={r['warning']}" if r.get("warning") else ""))
        return True
    print(f"  {tag}: 失败 {r.get('message','')}")
    return False


def cmd_dlg(args):
    """生成对话音频，等价前端「生成」/「批量生成全部」按钮。"""
    scripts = load_scripts(args.session)
    if not scripts:
        raise SystemExit("没有 *_audio_scripts.json；这个文件由 AI 读 md 后整份写出")
    vdir = SESSIONS_ROOT / args.session / "voices"
    existing = {f.name for f in vdir.glob("dlg_*.mp3")} if vdir.exists() else set()
    ok = fail = skipped = 0
    for f, data in scripts:
        page = str(data.get("page") or f.name[:5])
        if args.page and page != args.page:
            continue
        ds = data.get("dialogues") or []
        for i, d in enumerate(ds):
            d["_idx"] = i
            want = args.ref.lstrip("@") if args.ref else None
            have = (d.get("ref") or _derived_ref(i)).lstrip("@")
            if want and have != want:
                continue
            if not args.force and any(n.startswith(f"dlg_{page}_{have}_") for n in existing):
                skipped += 1
                continue
            ok += gen_one_dialogue(args.base, args.session, page, d)
    if ok == 0 and fail == 0:
        if skipped:
            print(f"全部已生成过（跳过 {skipped} 条）；要重新生成加 --force")
        else:
            print("没有匹配的对话（检查 --page / --ref）")
    else:
        print(f"完成：成功 {ok} 条" + (f"，跳过已有 {skipped} 条" if skipped else ""))



# ---------- 按 md 分镜顺序重排 ----------

MD_REF_RE = re.compile(r"@对话(\d+)")


def md_reference_order(md_text):
    """从 md 分镜段提取 @对话N 的出现顺序。
    只找 ## 分镜 到下一个 ## 之间的引用，不把「对话引用」清单算进去。"""
    order, inside = [], False
    for ln in md_text.splitlines():
        s = ln.strip()
        if s.startswith("## "):
            inside = s.startswith("## 分镜")
            continue
        if inside:
            for m in MD_REF_RE.finditer(ln):
                order.append(int(m.group(1)))
    return order


def normalize_text(s):
    """比对用：去掉空白和标点，只留文字，便于匹配 md 台词与 OCR 原文。"""
    return "".join(ch for ch in (s or "") if ch.isalnum())


def md_dialogue_lines(md_text):
    """从 md 的「## 分镜」段抽出所有台词行，按出现顺序返回 [(speaker, text)]。"""
    out, inside = [], False
    for ln in md_text.splitlines():
        s = ln.strip()
        if s.startswith("## "):
            inside = s.startswith("## 分镜")
            continue
        if not inside or not s.startswith(">"):
            continue
        body = s.lstrip(">").strip()
        if "：" in body:
            spk, _, text = body.partition("：")
            out.append((spk.strip(), text.strip()))
        elif ":" in body:
            spk, _, text = body.partition(":")
            out.append((spk.strip(), text.strip()))
        else:
            out.append(("", body))
    return out


def cmd_reorder(args):
    """按 md 里台词的顺序重排该页 regions。

    新格式的 md 不写 @对话N，台词是完整中文（可能已改过错别字），
    所以用「相似度」把 md 台词对应回 json 的框。
    """
    from difflib import SequenceMatcher

    sdir = SESSIONS_ROOT / args.session
    page = normalize_page(args.page)
    md_path = sdir / (args.page + ".md")
    if not md_path.exists():
        raise SystemExit(str(md_path) + " 不存在；先写 md 分镜")
    md_text = md_path.read_text(encoding="utf-8")
    lines = md_dialogue_lines(md_text)
    if not lines:
        raise SystemExit("md 的 ## 分镜 段里没有找到以 > 开头的台词行")

    p = get_page(args.base, args.session, page)
    regions = p["regions"]
    pool = [(i, normalize_text(r.get("text"))) for i, r in enumerate(regions)]
    used, order = set(), []
    unmatched = []
    for spk, text in lines:
        key = normalize_text(text)
        if not key:
            continue
        best, best_score = None, 0.0
        for i, rt in pool:
            if i in used or not rt:
                continue
            score = SequenceMatcher(None, key, rt).ratio()
            if score > best_score:
                best, best_score = i, score
        if best is not None and best_score >= args.threshold:
            used.add(best)
            order.append(best)
        else:
            unmatched.append((spk, text[:20], round(best_score, 2)))

    if not order:
        raise SystemExit("没有一条 md 台词能匹配到框（相似度都低于 %.2f）" % args.threshold)
    leftover = [i for i in range(len(regions)) if i not in used]

    if unmatched:
        print("匹配不上的台词（不会进入音频脚本，请检查）：")
        for spk, t, sc in unmatched:
            print("  %s：%s…  最高相似度 %.2f" % (spk or "?", t, sc))
    if leftover:
        print("没被任何台词用到的框：%s" % leftover)
    if (unmatched or leftover) and not args.force:
        raise SystemExit("存在未匹配项，未写入。确认后加 --force 只重排匹配成功的部分")

    new_regions = [regions[i] for i in order]
    if args.dry_run:
        print("%s: 预览（未写入）" % page)
        for new, old in enumerate(order):
            print("  #%d -> #%d  %r" % (old, new, (regions[old].get("text") or "")[:26]))
        return

    put_regions(args.base, args.session, page, new_regions,
                "按 md 台词顺序重排 %d 框" % len(new_regions), op="box-reorder")
    print("%s: 已按 md 台词顺序重排 %d 框" % (page, len(new_regions)))
    for new, old in enumerate(order):
        print("  #%d（原 #%d）%r" % (new, old, (regions[old].get("text") or "")[:26]))


def cmd_reorder_all(args):
    """对会话里所有页做 reorder，跳过没有 md 的页。"""
    sdir = SESSIONS_ROOT / args.session
    pages = sorted(x.stem[:5] for x in sdir.glob("*.md") if x.stem[:5].isdigit())
    if not pages:
        raise SystemExit(str(sdir) + " 下没有 NNNNN.md")
    for page in pages:
        sub = argparse.Namespace(**vars(args))
        sub.page = page
        print("--- %s ---" % page)
        try:
            cmd_reorder(sub)
        except SystemExit as e:
            print("  跳过: %s" % e)



# ---------- 音频脚本 / 角色档案 校验 ----------

ALLOWED_DIALOGUE_KEYS = {"speaker", "page", "text", "performance"}
ALLOWED_CHAR_KEYS = {"name", "appearance", "voiceprint_desc",
                     "voiceprint_audio", "api_ref_audio", "final_ref_audio"}


def check_audio_script(path, chars, issues, warns):
    name = path.name
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        issues.append("%s: JSON 解析失败 %s" % (name, e))
        return None, 0
    if not isinstance(data, dict):
        issues.append("%s: 顶层必须是对象" % name)
        return None, 0
    for key in ("characters", "dialogues"):
        if key not in data:
            issues.append("%s: 缺少 %s 字段" % (name, key))
    chs = data.get("characters")
    dgs = data.get("dialogues")
    if not isinstance(chs, dict):
        issues.append("%s: characters 必须是对象（名字 -> 档案）" % name)
        chs = {}
    if not isinstance(dgs, list):
        issues.append("%s: dialogues 必须是数组" % name)
        dgs = []
    page = name[:5]
    for k, v in chs.items():
        extra = set(v or {}) - {"description", "voiceprint", "ref_api", "ref_final"}
        if extra:
            warns.append("%s: 角色 %s 有非标准字段 %s" % (name, k, sorted(extra)))
        if not (v or {}).get("description"):
            warns.append("%s: 角色 %s 缺少 description" % (name, k))
    seen = set()
    for i, d in enumerate(dgs):
        tag = "%s 第 %d 条" % (name, i + 1)
        if not isinstance(d, dict):
            issues.append("%s: 不是对象" % tag)
            continue
        extra = set(d) - ALLOWED_DIALOGUE_KEYS
        if extra:
            issues.append("%s: 多余字段 %s（只允许 speaker/page/text/performance）" % (tag, sorted(extra)))
        spk = (d.get("speaker") or "").strip()
        txt = (d.get("text") or "").strip()
        perf = (d.get("performance") or "").strip()
        if not spk:
            issues.append("%s: speaker 为空" % tag)
        elif chars and spk not in chars:
            issues.append("%s: speaker %s 不在 characters.json" % (tag, spk))
        else:
            seen.add(spk)
        if not txt:
            issues.append("%s: text 为空" % tag)
        elif "@对话" in txt:
            issues.append("%s: text 里还有 @对话N，应写完整台词" % tag)
        if not perf:
            issues.append("%s: performance 为空" % tag)
        elif len(perf) < 12:
            warns.append("%s: performance 太短，可能没写情绪/配乐/音效" % tag)
        if d.get("page") and str(d.get("page")) != page:
            issues.append("%s: page 是 %s，与文件名 %s 不符" % (tag, d.get("page"), page))
    missing = set(chs) - seen
    if missing:
        warns.append("%s: 这些角色没有台词 %s" % (name, sorted(missing)))
    return page, len(dgs)


def norm_text(s):
    """去掉标点空白，只留文字，用于覆盖率比对。"""
    return "".join(ch for ch in (s or "") if ch.isalnum())


def text_coverage(needle, hay):
    """needle 有多少比例能在 hay 里找到（允许改字、同义改写）。"""
    from difflib import SequenceMatcher
    n, h = norm_text(needle), norm_text(hay)
    if not n:
        return 1.0
    sm = SequenceMatcher(None, n, h, autojunk=False)
    return sum(b.size for b in sm.get_matching_blocks()) / float(len(n))


def is_label_or_note(text):
    """名牌、场景注释不该进对话：短且带空格，或含身份/地点关键词。"""
    t = (text or "").strip()
    n = norm_text(t)
    if len(n) < 16 and (" " in t or chr(0x3000) in t):
        return True
    if len(n) <= 8 and any(k in t for k in (chr(0x56fd)+chr(0x4e3b),
                                             chr(0x5927)+chr(0x81e3),
                                             chr(0x5e55)+chr(0x5e9c),
                                             chr(0x5546)+chr(0x4e1a)+chr(0x8857),
                                             chr(0x9996)+chr(0x90fd))):
        return True
    return False


def frames_for_page(base, session, page):
    try:
        p = get_page(base, session, page)
    except SystemExit:
        return []
    out = []
    for j, r in enumerate(p.get("regions") or []):
        t = (r.get("text") or "").strip()
        if not norm_text(t):
            continue
        out.append({"idx": j, "text": t, "label": is_label_or_note(t)})
    return out


def best_frame_range(text, frames):
    best = (None, None, 0.0)
    n = len(frames)
    for i in range(n):
        if frames[i]["label"]:
            continue
        acc = ""
        for j in range(i, n):
            if frames[j]["label"] and j > i:
                break
            acc += frames[j]["text"]
            cov = text_coverage(text, acc)
            nf = j - i + 1
            if cov > best[2] + 1e-9:
                best = (i, j, cov)
            elif abs(cov - best[2]) < 1e-9 and best[0] is not None and nf < (best[1] - best[0] + 1):
                best = (i, j, cov)
    return best


def check_coverage(base, session, page, dialogues, threshold, issues, warns, notes):
    frames = frames_for_page(base, session, page)
    if not frames:
        return
    mapped = []
    for i, d in enumerate(dialogues):
        txt = d.get("text") or ""
        if not norm_text(txt):
            continue
        tag = "%s 第 %d 条（%s）" % (page, i + 1, d.get("speaker") or "?")
        a, b, cov = best_frame_range(txt, frames)
        if a is None:
            warns.append("%s: 找不到对应的原框内容" % tag)
            continue
        nf = b - a + 1
        orig = "".join(frames[k]["text"] for k in range(a, b + 1))
        mapped.append((a, b))
        idxs = [frames[k]["idx"] for k in range(a, b + 1)]
        if nf == 1:
            span = "#%d" % idxs[0]
        else:
            span = "#%d~#%d (%d 个框)" % (idxs[0], idxs[-1], nf)
        n_orig, n_now = len(norm_text(orig)), len(norm_text(txt))
        if cov < threshold:
            issues.append("%s: 覆盖率 %.0f%%，低于 %.0f%% -> 对应 %s，原文 %d 字，现在 %d 字"
                          % (tag, cov * 100, threshold * 100, span, n_orig, n_now))
        elif nf > 1:
            warns.append("%s: 合并了 %d 个框（%s），覆盖率 %.0f%%"
                         % (tag, nf, span, cov * 100))
        elif cov < 0.95:
            warns.append("%s: 覆盖率 %.0f%%（对应 %s，原文 %d 字，现在 %d 字）"
                         % (tag, cov * 100, span, n_orig, n_now))
    per_frame = {}
    for a, b in mapped:
        for k in range(a, b + 1):
            per_frame[k] = per_frame.get(k, 0) + 1
    for k, cnt in sorted(per_frame.items()):
        if cnt == 1:
            continue
        # 只有该框内容被「分别」切进多条对话才算拆分；
        # 若其中一条对话本身已完整包含它，那只是贪心匹配的重叠，不是问题。
        split = False
        for a, b in mapped:
            if a <= k <= b:
                seg = "".join(frames[x]["text"] for x in range(a, b + 1))
                own = text_coverage(frames[k]["text"], seg)
                if own < 0.9:
                    split = True
        if split:
            warns.append("%s: 框 #%d 的内容被拆进多条对话，确认是否漏字"
                         % (page, frames[k]["idx"]))
    all_dlg = "".join((d.get("text") or "") for d in dialogues)
    covered = set()
    for a, b in mapped:
        covered.update(range(a, b + 1))
    for k, f in enumerate(frames):
        if f["label"] or k in covered:
            continue
        cov = text_coverage(f["text"], all_dlg)
        if cov >= threshold:
            continue
        notes.append("%s: 框 #%d 只有 %.0f%% 的内容进了对话，可能漏了：%s"
                     % (page, f["idx"], cov * 100, f["text"][:26]))


def post_audit(base, session, scope, issues, warns, notes, extra):
    """把检查结论写进画布历史（web 失败不影响检查本身）。"""
    payload = {"scope": scope, "by": "cli",
               "errors": list(issues), "warns": list(warns),
               "notes": list(notes)}
    payload.update(extra or {})
    try:
        r = api(base, "POST", "/api/session/%s/audit" % session, json=payload)
        if isinstance(r, dict) and r.get("opId"):
            print("  （已记入历史 %s）" % r["opId"])
    except SystemExit as e:
        print("  （写历史失败: %s）" % e)


def cmd_check_audio(args):
    sdir = SESSIONS_ROOT / args.session
    chars = load_characters(args.session)
    files = sorted(sdir.glob("*_audio_scripts.json"))
    if not files:
        raise SystemExit(str(sdir) + " 下没有 *_audio_scripts.json")
    issues, warns, pages, total = [], [], [], 0
    cov_notes = []
    for f in files:
        page, n = check_audio_script(f, chars, issues, warns)
        if page:
            pages.append(page)
            total += n
    print("检查 %d 个文件，%d 条对话" % (len(files), total))
    for page in pages:
        try:
            p = get_page(args.base, args.session, page)
        except SystemExit:
            continue
        nreg = len(p.get("regions") or [])
        f = sdir / (page + "_audio_scripts.json")
        try:
            n = len(json.loads(f.read_text(encoding="utf-8")).get("dialogues") or [])
        except Exception:
            continue
        if n > nreg:
            issues.append("%s: 对话 %d 条，但这一页只有 %d 个框" % (page, n, nreg))
        elif n < nreg:
            warns.append("%s: 对话 %d 条，框 %d 个（可能有框不需要配音）" % (page, n, nreg))
        # 覆盖率：每条对话和该页框的 OCR 原文比对
        if getattr(args, "coverage", None) is not None:
            try:
                dlg = json.loads(f.read_text(encoding="utf-8")).get("dialogues") or []
            except Exception:
                dlg = []
            check_coverage(args.base, args.session, page, dlg,
                           args.coverage, issues, warns, cov_notes)
    for w in warns:
        print("  [提示] " + w)
    for e in issues:
        print("  [错误] " + e)
    for n in cov_notes:
        print("  [缺漏] " + n)
    print("结果：" + ("通过" if not issues else "%d 个错误" % len(issues)))
    post_audit(args.base, args.session, "audio", issues, warns, cov_notes, {
        "dialogues": total, "files": len(files), "threshold": args.coverage,
    })
    return 0 if not issues else 1


def cmd_check_chars(args):
    sdir = SESSIONS_ROOT / args.session
    path = sdir / "characters.json"
    if not path.exists():
        raise SystemExit(str(path) + " 不存在")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        raise SystemExit("JSON 解析失败: %s" % e)
    if isinstance(data, dict) and isinstance(data.get("characters"), list):
        raise SystemExit("结构错误：应为扁平对象（名字 -> 档案），不是 {characters: [...]}")
    if not isinstance(data, dict):
        raise SystemExit("结构错误：顶层必须是对象")
    vdir = sdir / "voices"
    issues, warns = [], []
    for name, c in data.items():
        if not isinstance(c, dict):
            issues.append("%s: 档案不是对象" % name)
            continue
        extra = set(c) - ALLOWED_CHAR_KEYS
        if extra:
            warns.append("%s: 多余字段 %s" % (name, sorted(extra)))
        if c.get("name") and c.get("name") != name:
            issues.append("%s: name 字段是 %s，与键名不一致" % (name, c.get("name")))
        ap = (c.get("appearance") or "").strip()
        if not ap:
            issues.append("%s: appearance 为空（无法在图上认人）" % name)
        elif len(ap) < 15:
            warns.append("%s: appearance 太短，可能不足以区分角色" % name)
        if not (c.get("voiceprint_desc") or "").strip():
            issues.append("%s: voiceprint_desc 为空" % name)
        for key in ("voiceprint_audio", "api_ref_audio", "final_ref_audio"):
            fn = (c.get(key) or "").strip()
            if fn and not (vdir / Path(fn).name).exists():
                issues.append("%s: %s 指向的文件不存在（%s）" % (name, key, fn))
    print("角色 %d 个" % len(data))
    for w in warns:
        print("  [提示] " + w)
    for e in issues:
        print("  [错误] " + e)
    print("结果：" + ("通过" if not issues else "%d 个错误" % len(issues)))
    post_audit(args.base, args.session, "characters", issues, warns, [], {
        "characters": len(data),
    })
    return 0 if not issues else 1


def build_parser():
    ap = argparse.ArgumentParser(prog="canvas_cli", description="漫画画布技能 CLI")
    ap.add_argument("--base", default=DEFAULT_BASE)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("check", help="探活画布与 OCR 服务"); s.set_defaults(func=cmd_check)
    s = sub.add_parser("doctor", help="启动检查：配置没填就拉起服务并打开设置页")
    s.add_argument("--no-browser", action="store_true", help="配置缺失时不自动打开设置页")
    s.set_defaults(func=cmd_doctor)
    s = sub.add_parser("list"); s.add_argument("session"); s.set_defaults(func=cmd_list)
    s = sub.add_parser("show"); s.add_argument("session"); s.add_argument("page"); s.set_defaults(func=cmd_show)
    s = sub.add_parser("init"); s.add_argument("session"); s.add_argument("images", nargs="+"); s.set_defaults(func=cmd_init)
    s = sub.add_parser("ocr"); s.add_argument("session"); s.add_argument("--pages", nargs="*")
    # 刻意不提供 --wait：等待整本 OCR 会让人干等十几分钟且零产出。
    # 正确用法是排队后立刻用 next 逐页往下做。
    s.set_defaults(func=cmd_ocr)
    s = sub.add_parser("next", help="流水线取页：取最早一页已 OCR 完但未写 md 的页")
    s.add_argument("session"); s.set_defaults(func=cmd_next)
    s = sub.add_parser("plan", help="开工计划：打印页数、数据目录、实时地址和步骤")
    s.add_argument("session"); s.set_defaults(func=cmd_plan)
    s = sub.add_parser("add"); s.add_argument("session"); s.add_argument("page")
    s.add_argument("box", nargs=4, type=int); s.add_argument("text"); s.set_defaults(func=cmd_add)
    s = sub.add_parser("rm"); s.add_argument("session"); s.add_argument("page")
    s.add_argument("index", type=int, nargs="*"); s.set_defaults(func=cmd_rm)
    s = sub.add_parser("scrub"); s.add_argument("session"); s.add_argument("page", nargs="?", default="all")
    s.set_defaults(func=cmd_scrub)
    s = sub.add_parser("fix"); s.add_argument("session"); s.add_argument("page")
    s.add_argument("--rm", default=None); s.add_argument("--add", type=int, nargs=4, default=None)
    s.add_argument("--text", default=None); s.set_defaults(func=cmd_fix)
    s = sub.add_parser("reorder"); s.add_argument("session")
    s.add_argument("page", nargs="?", default=None)
    s.add_argument("--dry-run", action="store_true"); s.add_argument("--force", action="store_true")
    s.set_defaults(func=lambda a: cmd_reorder_all(a) if not a.page else cmd_reorder(a))
    s = sub.add_parser("voices"); s.add_argument("session"); s.set_defaults(func=cmd_voices)
    s = sub.add_parser("check-audio"); s.add_argument("session")
    s.add_argument("--coverage", type=float, default=0.9,
                   help="台词覆盖率下限，默认 0.9；设 1.0 要求逐字一致")
    s.set_defaults(func=cmd_check_audio)
    s = sub.add_parser("check-characters"); s.add_argument("session"); s.set_defaults(func=cmd_check_chars)
    s = sub.add_parser("vp"); s.add_argument("session"); s.add_argument("names", nargs="*"); s.set_defaults(func=cmd_vp)
    s = sub.add_parser("dlg"); s.add_argument("session"); s.add_argument("--page", default=None); s.add_argument("--ref", default=None); s.add_argument("--force", action="store_true"); s.set_defaults(func=cmd_dlg)
    s = sub.add_parser("view"); s.add_argument("session"); s.add_argument("page")
    s.add_argument("--prompt", default=None); s.add_argument("--out", default=None)
    s.set_defaults(func=cmd_view)
    return ap


if __name__ == "__main__":
    # 有人（通常是 AI）爱加 --wait 干等整本识别。这个参数已经删了，
    # 直接说清楚怎么改，而不是丢一句 unrecognized arguments。
    if "--wait" in sys.argv[1:]:
        print("ocr 没有 --wait 参数，也不会等你等到全部识别完。")
        print("正确做法：先 python canvas_cli.py ocr <会话> 排队，")
        print("然后用 python canvas_cli.py next <会话> 一页一页取着做。")
        raise SystemExit(2)
    a = build_parser().parse_args()
    a.func(a)

