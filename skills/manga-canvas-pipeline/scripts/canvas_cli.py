"""canvas_cli - 漫画画布技能 CLI（manga-canvas-pipeline）

一切写入都通过画布 HTTP 接口（server/canvas.mjs 7788），留历史、SSE 广播、
前端实时刷新；禁止直接改 sessions/<会话>/ 下的 json。

框规则：只有新增（add）和删除（rm），没有编辑；改文字 = rm + add。

子命令：
    list   <会话>                              列出所有页和框数
    show   <会话> <页>                         打印该页所有框（#编号 坐标 文字）
    init   <会话> <图片...>                    新建会话（文件夹只放图片）
    ocr    <会话> [--pages NNNNN ...]          整页识别（走画布任务队列）
    add    <会话> <页> x1 y1 x2 y2 文字        新增框
    rm     <会话> <页> <编号>                  删除框
    md     <会话> <页> [--out 路径]            生成分镜 md 骨架（@对话N 引用）
    audio  <会话> <页> [--out 路径]            生成 audio_scripts.json 骨架
    voices <会话>                              查看/初始化会话角色声纹状态
    view   <会话> <页> [--prompt 补充提示词] [--out 路径]
                                               AI 视觉校验：预览图+框数据一次给出 PASS/FAIL 与修复方向
    ai-audio <会话> [--pages NNNNN ...]        AI 填写 performance 音频提示词（豆包导演式）
    vp     <会话> [角色名 ...]                  生成角色声纹（缺省=全部角色）
    dlg    <会话> [--page NNNNN] [--ref 对话N] [--all]
                                               生成对话音频（--all=本会话全部）
    check                                     探活两个服务
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path
from urllib.parse import urlencode
from concurrent.futures import ThreadPoolExecutor

import requests

DEFAULT_BASE = "http://127.0.0.1:7788"
OCR_BASE = "http://127.0.0.1:5009"
SESSIONS_ROOT = Path("I:/comic-canvas/sessions")

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
            print("    画布: node I:/comic-canvas/server/canvas.mjs")
            print("    OCR:  I:/manga-image-translator/py310/python.exe "
                  "I:/comic-canvas/server/ocr_service.py --port 5009 --use-gpu")


def get_page(base, session, page):
    return api(base, "GET", f"/api/session/{session}/page/{page}")


def put_regions(base, session, page, regions, summary, box=None, op="box-edit", boxes=None):
    return api(base, "PUT", f"/api/session/{session}/page/{page}",
               json={"regions": regions, "by": "manga-canvas-cli",
                     "op": op, "summary": summary, "force": True,
                     "box": box, "boxes": boxes})


def wait_jobs(base, pages, timeout=900):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = api(base, "GET", "/api/jobs")
        if not st.get("running") and not (st.get("queued") or 0):
            break
        time.sleep(2)
    st = api(base, "GET", "/api/jobs")
    return [j for j in st["jobs"] if j.get("page") in pages]


def cmd_check(args):
    check_services()


def cmd_list(args):
    d = api(args.base, "GET", f"/api/session/{args.session}")
    for p in d["pages"]:
        print(f"  {p['page']}  {p['width']}x{p['height']}  {len(p['regions'])} 框")
    print(f"共 {len(d['pages'])} 页")


def cmd_show(args):
    p = get_page(args.base, args.session, args.page)
    print(f"{args.page}  {p['width']}x{p['height']}  {len(p['regions'])} 框")
    for i, r in enumerate(p["regions"]):
        box = ",".join(str(int(v)) for v in r["box"])
        print(f"  #{i:<2} [{box}] {r.get('text','')!r}  ({r.get('source','')})")


def cmd_init(args):
    api(args.base, "POST", "/api/sessions", json={"name": args.session})
    imgs = sorted(Path(p) for p in args.images)
    missing = [str(p) for p in imgs if not p.exists()]
    if missing:
        raise SystemExit("找不到图片: " + ", ".join(missing))
    files = [{"name": p.name,
              "data": "data:image/jpeg;base64," + base64.b64encode(p.read_bytes()).decode()}
             for p in imgs]
    print(api(args.base, "POST", f"/api/session/{args.session}/upload", json={"files": files}))
    print(f"sessions/{args.session} 已建立（只含 {len(files)} 张图）")


def cmd_ocr(args):
    d = api(args.base, "GET", f"/api/session/{args.session}")
    pages = [p["page"] for p in d["pages"]]
    if args.pages:
        pages = [p for p in pages if p in args.pages]
    if not pages:
        raise SystemExit("没有要识别的页")
    for pg in pages:
        job = api(args.base, "POST", f"/api/session/{args.session}/job",
                  json={"page": pg, "mode": "ocr-page"})
        print(f"  排队 {pg}: {job.get('id')}")
    done = wait_jobs(args.base, pages)
    for j in done:
        r = j.get("result") or {}
        print(f"  {j.get('page')} {j.get('status')} {r.get('count','')} 框 {j.get('error','')}")
    for pg in pages:
        p = get_page(args.base, args.session, pg)
        print(f"  {pg}: {len(p['regions'])} 框")


def cmd_add(args):
    p = get_page(args.base, args.session, args.page)
    regions = p["regions"]
    regions.append({"box": [args.box[0], args.box[1], args.box[2], args.box[3]],
                    "text": args.text, "translation": "", "lang": "zh",
                    "prob": 1.0, "angle": 0, "source": "manual"})
    put_regions(args.base, args.session, args.page, regions,
                f"补框：{args.text[:16]}", box=args.box, op="box-add")
    print(f"新增 1 框，现有 {len(regions)} 框")
    print(f"  新框编号 = #{len(regions) - 1}（追加在末尾，已有框编号不变）")


def cmd_rm(args):
    """删除框。编号 = 该页 regions 数组下标；删掉一个，其后编号会前移一位。"""
    p = get_page(args.base, args.session, args.page)
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
    put_regions(args.base, args.session, args.page, regions, summary, op="box-del",
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
    p = get_page(args.base, args.session, args.page)
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
    put_regions(args.base, args.session, args.page, regions,
                f"改框 rm={idxs} add={args.add}", op="box-edit")
    print(f"已改：删 {len(idxs)} 框，加 {1 if args.add else 0} 框，现 {len(regions)} 框")
    for i, r in enumerate(regions):
        print(f"  #{i} [{','.join(str(int(v)) for v in r['box'])}] "
              f"{(r.get('text') or '')[:24]!r}")


# ---------- md 骨架 ----------

def cmd_md(args):
    p = get_page(args.base, args.session, args.page)
    regions = p["regions"]
    out = args.out or str(SESSIONS_ROOT / args.session / f"{args.page}.md")
    lines = [f"# {args.page} · <本页标题>",
             "",
             "## 分镜",
             ""]
    for i, r in enumerate(regions):
        box = r["box"]
        y = int(box[1])
        pct = round(y / p["height"] * 100)
        lines.append(f"**P{i + 1}**（约 {pct}% 高度起）<镜头：远景/中景/特写>："
                     f"<画面描述> @对话{i}")
    lines += ["", "## 对话引用", ""]
    for i, r in enumerate(regions):
        t = r.get("text") or ""
        lines.append(f"- @对话{i}（#{i} [{','.join(str(int(v)) for v in r['box'])}]）：{t}")
    lines += ["", "## 校对", "",
              "- [ ] 所有需要念的文字已框选（检查图逐块核对）"]
    Path(out).write_text("\n".join(lines), encoding="utf-8")
    print(f"骨架已写 {out}（regions={len(regions)}），agent 填充画面描述后保存")


# ---------- audio_scripts 骨架 ----------

def cmd_audio(args):
    p = get_page(args.base, args.session, args.page)
    regions = p["regions"]
    out = args.out or str(SESSIONS_ROOT / args.session / f"{args.page}_audio_scripts.json")
    data = {
        "characters": {},
        "dialogues": [
            {"ref": f"@对话{i}", "speaker": "<角色名>", "page": args.page,
             "text": (r.get("text") or ""),
             "tone": "",
             "performance": "<导演式提示词：按豆包 audio-1.0 官方范式写声音分镜——"
                            "用可听行为（音色/气息/语速/停顿/副语言）按时间顺序描述这句台词"
                            "怎么演，长句里情绪变化逐段写出来；不要用抽象情绪词。>"
             }
            for i, r in enumerate(regions)
        ],
    }
    Path(out).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"骨架已写 {out}（dialogues={len(regions)}）；characters 由 agent 从 md 抽离后填入")


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
    return json.loads(Path("I:/comic-canvas/settings.json").read_text(encoding="utf-8"))


def cmd_view(args):
    """AI 视觉校验。page 可写单页，也可写 'all' 或逗号分隔的多页。"""
    raw = str(args.page).strip()
    if raw.lower() == "all":
        d = api(args.base, "GET", f"/api/session/{args.session}")
        pages = [p["page"] for p in d["pages"]]
    else:
        pages = [x.strip() for x in raw.split(",") if x.strip()]
    if not pages:
        raise SystemExit("没有要校验的页")

    st = load_settings().get("openai", {})

    def check(page):
        params = {"session": args.session, "page": page, "grid": "1", "labels": "1",
                  "gray": "1", "q": "35", "scale": "0.5"}
        r = requests.get(args.base.rstrip("/") + "/render?" + urlencode(params), timeout=60)
        if r.status_code >= 400:
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
                return page, answer.strip(), answer.strip().upper().startswith("PASS")
            except Exception as e:
                last = f"{type(e).__name__}: {e}"
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


def gen_one_dialogue(base, session, page, d):
    r = api(base, "POST", "/api/audio/generate", json={
        "session": session, "name": d.get("speaker") or "", "purpose": "dialogue",
        "text": d.get("text") or "", "tone": d.get("tone") or "",
        "performance": d.get("performance") or "",
        "ref": d.get("ref") or "", "page": page,
    })
    tag = f"{page} {d.get('ref','')} {d.get('speaker','')}"
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
        raise SystemExit("没有 *_audio_scripts.json；先用 audio 命令生成骨架并填充")
    vdir = SESSIONS_ROOT / args.session / "voices"
    existing = {f.name for f in vdir.glob("dlg_*.mp3")} if vdir.exists() else set()
    ok = fail = skipped = 0
    for f, data in scripts:
        page = str(data.get("page") or f.name[:5])
        if args.page and page != args.page:
            continue
        ds = data.get("dialogues") or []
        for i, d in enumerate(ds):
            want = args.ref.lstrip("@") if args.ref else None
            have = (d.get("ref") or f"@对话{i}").lstrip("@")
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



def build_parser():
    ap = argparse.ArgumentParser(prog="canvas_cli", description="漫画画布技能 CLI")
    ap.add_argument("--base", default=DEFAULT_BASE)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("check", help="探活画布与 OCR 服务"); s.set_defaults(func=cmd_check)
    s = sub.add_parser("list"); s.add_argument("session"); s.set_defaults(func=cmd_list)
    s = sub.add_parser("show"); s.add_argument("session"); s.add_argument("page"); s.set_defaults(func=cmd_show)
    s = sub.add_parser("init"); s.add_argument("session"); s.add_argument("images", nargs="+"); s.set_defaults(func=cmd_init)
    s = sub.add_parser("ocr"); s.add_argument("session"); s.add_argument("--pages", nargs="*"); s.set_defaults(func=cmd_ocr)
    s = sub.add_parser("add"); s.add_argument("session"); s.add_argument("page")
    s.add_argument("box", nargs=4, type=int); s.add_argument("text"); s.set_defaults(func=cmd_add)
    s = sub.add_parser("rm"); s.add_argument("session"); s.add_argument("page")
    s.add_argument("index", type=int, nargs="*"); s.set_defaults(func=cmd_rm)
    s = sub.add_parser("scrub"); s.add_argument("session"); s.add_argument("page", nargs="?", default="all")
    s.set_defaults(func=cmd_scrub)
    s = sub.add_parser("fix"); s.add_argument("session"); s.add_argument("page")
    s.add_argument("--rm", default=None); s.add_argument("--add", type=int, nargs=4, default=None)
    s.add_argument("--text", default=None); s.set_defaults(func=cmd_fix)
    s = sub.add_parser("md"); s.add_argument("session"); s.add_argument("page")
    s.add_argument("--out", default=None); s.set_defaults(func=cmd_md)
    s = sub.add_parser("audio"); s.add_argument("session"); s.add_argument("page")
    s.add_argument("--out", default=None); s.set_defaults(func=cmd_audio)
    s = sub.add_parser("voices"); s.add_argument("session"); s.set_defaults(func=cmd_voices)
    s = sub.add_parser("vp"); s.add_argument("session"); s.add_argument("names", nargs="*"); s.set_defaults(func=cmd_vp)
    s = sub.add_parser("dlg"); s.add_argument("session"); s.add_argument("--page", default=None); s.add_argument("--ref", default=None); s.add_argument("--force", action="store_true"); s.set_defaults(func=cmd_dlg)
    s = sub.add_parser("view"); s.add_argument("session"); s.add_argument("page")
    s.add_argument("--prompt", default=None); s.add_argument("--out", default=None)
    s.set_defaults(func=cmd_view)
    return ap


if __name__ == "__main__":
    a = build_parser().parse_args()
    a.func(a)

