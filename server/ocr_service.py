"""漫画 OCR 服务 —— 接口层，算法来自同目录 mask_column_ocr.py。

在整个流程中的位置：
    canvas.mjs (7788) 收到画布前端的识别任务后，按任务模式调本服务对应接口；
    本服务只做「找框 + 认字」，不翻译、不擦除、不渲染，模型调用的唯一入口。

    任务模式        -> 接口
    整页找框        -> POST /detect        （只回坐标）
    整页识别        -> POST /ocr
    区域找框        -> POST /detect/region （裁图后只对这块跑）
    区域识别        -> POST /ocr/region
    框内识别        -> POST /ocr/box       （单个框独立跑一遍完整流程）

算法 = mask_column_ocr.py（检测 mask → 分块 → 按墨迹投影切列/行 → 逐条 OCR → 按阅读序拼接），
实测同一气泡整块方案字错率 46.6%，本方案 4.0%。

启动：
    I:/manga-image-translator/py310/python.exe server/ocr_service.py --port 5009 --use-gpu
    （工作目录必须是本仓库根，见 start.bat）
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import time
import logging
import logging.handlers
import traceback
from datetime import datetime

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel
import uvicorn

# 算法依赖 manga-image-translator 的包路径（模型解析也依赖其 cwd）。
# 路径来源：环境变量 MT_ROOT > settings.json 的 translator.projectRoot。
# 都没有时直接报错并给出安装指引，不猜默认值。
import json
import sys, os
from pathlib import Path

def _load_mt_root():
    env = os.environ.get("MT_ROOT")
    if env and Path(env).is_dir():
        return Path(env)
    sf = (Path(os.environ.get("STUDIO_DATA_DIR")) if os.environ.get("STUDIO_DATA_DIR")
          else Path.home() / ".manga-panel-studio") / "settings.json"
    if sf.exists():
        try:
            root = (json.loads(sf.read_text(encoding="utf-8")).get("translator") or {}).get("projectRoot") or ""
            if root and Path(root).is_dir():
                return Path(root)
        except Exception:
            pass
    return None

_mt = _load_mt_root()
if _mt is None:
    raise SystemExit(
        "未找到 manga-image-translator。\n"
        "请二选一：\n"
        "  1. 设置环境变量 MT_ROOT 指向 manga-image-translator 目录；\n"
        "  2. 打开设置页（画布服务 7788/settings.html），在「路径与端口」里填 translator.projectRoot。\n"
        "还没有安装？让 AI agent 按官方说明克隆安装："
        "git clone https://github.com/zyddnys/manga-image-translator.git"
    )
MT = str(_mt)
sys.path.insert(0, MT)
os.chdir(MT)

# 注意：MT 目录里也有一份同名的 mask_column_ocr.py（旧拷贝）。
# 如果直接 `from mask_column_ocr import ...`，加载的会是那一份，
# 本项目 server/mask_column_ocr.py 的修改就永远不生效。
# 所以这里按文件路径明确加载本目录的这一份。
import importlib.util

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "mask_column_ocr", os.path.join(_HERE, "mask_column_ocr.py"))
_mod = importlib.util.module_from_spec(_spec)
sys.modules["mask_column_ocr"] = _mod
_spec.loader.exec_module(_mod)

TextBlock = _mod.TextBlock
extract_columns = _mod.extract_columns


# ---------------- 日志 ----------------
# 独立于 manga-image-translator：本服务自己的日志，按天切分，保留 14 天。
# 目录优先级：OCR_LOG_DIR > <数据根>/logs；数据根 = STUDIO_DATA_DIR 或 ~/.manga-panel-studio
LOG = logging.getLogger("ocr-service")
_LOG_PATH = ""


def _default_log_dir() -> Path:
    env = os.environ.get("OCR_LOG_DIR")
    if env:
        return Path(env)
    data = os.environ.get("STUDIO_DATA_DIR") or str(Path.home() / ".manga-panel-studio")
    return Path(data) / "logs"


def setup_logging(level: str = "INFO") -> str:
    """按天轮转的文件日志（文件名带日期，每天一个新文件）。返回当天日志文件路径。"""
    global _LOG_PATH
    log_dir = _default_log_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    # 文件名直接带日期：每天一个新文件，不用打开旧的翻。
    path = log_dir / ("ocr-service-" + datetime.now().strftime("%Y%m%d") + ".log")
    _LOG_PATH = str(path)

    LOG.setLevel(getattr(logging, level.upper(), logging.INFO))
    LOG.handlers.clear()
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%Y-%m-%d %H:%M:%S")

    # 跨天午夜自动轮转：轮转文件名 ocr-service-YYYYMMDD.log（namer 决定日期格式），
    # 旧文件保留 14 天后自动删除。
    fh = logging.handlers.TimedRotatingFileHandler(
        path, when="midnight", backupCount=14, encoding="utf-8", delay=False)
    fh.setFormatter(fmt)
    LOG.addHandler(fh)

    LOG.propagate = False
    return str(path)


def read_image(b64: str) -> Image.Image:
    if "," in b64 and b64.strip().startswith("data:"):
        b64 = b64.split(",", 1)[1]
    try:
        raw = base64.b64decode(b64)
        return Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as e:
        raise HTTPException(400, f"图片解码失败: {e}")


def to_jpeg_b64(img: Image.Image, quality: int = 90) -> str:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def pil_to_np(img: Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.array(img.convert("RGB")), cv2.COLOR_RGB2BGR)[:, :, ::-1]


def block_to_region(b: TextBlock) -> dict:
    return {
        "box": [round(float(v), 1) for v in b.box],
        "text": b.text,
        "translation": "",
        "lang": "unknown",
        "prob": round(min((c.prob for c in b.columns), default=1.0), 3),
        "columns": [{"box": [round(float(v), 1) for v in c.box],
                     "text": c.text, "prob": round(float(c.prob), 3)}
                    for c in b.columns],
    }


def regions_response(image: Image.Image, blocks: list[TextBlock], t0: float,
                     input_img: Image.Image | None = None,
                     trace: dict | None = None) -> dict:
    out = {
        "width": image.width, "height": image.height,
        "ms": int((time.time() - t0) * 1000),
        "count": len(blocks),
        "regions": [block_to_region(b) for b in blocks],
        "algorithm": "mask-column",
    }
    if input_img is not None:
        out["input"] = to_jpeg_b64(input_img)
    if trace:
        out["trace"] = trace
    return out


def trace_to_b64(trace: dict | None) -> dict:
    """中间图（numpy BGR）→ base64 JPEG，并带上每一步的说明。"""
    if not trace:
        return {}
    steps = [
        ("mask", "检测 mask：模型认为有文字的地方（红色）"),
        ("blocks", "mask 分块：每个蓝色框是一个文字块"),
        ("columns", "切列/切行：绿色框是真正送去 OCR 的文字条"),
        ("strips", "送进 OCR 的文字条拼图（左上角是顺序号）"),
    ]
    out = {}
    for key, label in steps:
        img = trace.get(key)
        if img is None:
            continue
        bgr = np.ascontiguousarray(img)
        ok, enc = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        if not ok:
            continue
        out[key] = {
            "label": label,
            "image": base64.b64encode(enc.tobytes()).decode("ascii"),
        }
    if trace.get("counts"):
        out["counts"] = trace["counts"]
    return out


class Engine:
    """单卡串行，避免两个请求抢显存。"""

    def __init__(self, device: str):
        self.device = device
        self.lock = asyncio.Lock()

    async def extract(self, img: Image.Image) -> list[TextBlock]:
        async with self.lock:
            return await extract_columns(pil_to_np(img),
                                         det_device=self.device, ocr_device=self.device)

    async def extract_traced(self, img: Image.Image) -> tuple[list[TextBlock], dict]:
        """同一套算法，额外把每一步的中间图带回来。"""
        async with self.lock:
            trace: dict = {}
            blocks = await extract_columns(pil_to_np(img), det_device=self.device,
                                           ocr_device=self.device, trace_out=trace)
            return blocks, trace


class ImgReq(BaseModel):
    image: str


class RegionReq(BaseModel):
    image: str
    box: list[float]


class BatchReq(BaseModel):
    images: list[str]


def build_app(engine: Engine) -> FastAPI:
    app = FastAPI(title="manga-ocr-service", version="3.0")

    @app.middleware("http")
    async def log_requests(request, call_next):
        t0 = time.time()
        try:
            resp = await call_next(request)
        except Exception:
            LOG.error("%s %s 未处理异常\n%s", request.method, request.url.path,
                      traceback.format_exc())
            raise
        ms = int((time.time() - t0) * 1000)
        lvl = logging.INFO if resp.status_code < 400 else logging.WARNING
        LOG.log(lvl, "%s %s -> %s (%d ms)", request.method, request.url.path,
                resp.status_code, ms)
        return resp

    @app.on_event("startup")
    async def _on_startup():
        LOG.info("服务启动完成，device=%s，算法=mask-column", engine.device)
        LOG.info("日志文件: %s", _LOG_PATH)

    @app.get("/health")
    async def health():
        return {"ok": True, "device": engine.device, "algorithm": "mask-column",
                "modes": ["detect", "ocr", "detect/region", "ocr/region", "ocr/box", "ocr/batch"]}

    @app.post("/detect")
    async def detect(req: ImgReq):
        t0 = time.time()
        img = read_image(req.image)
        blocks, trace = await engine.extract_traced(img)
        out = regions_response(img, blocks, t0, trace=trace_to_b64(trace))
        for r in out["regions"]:
            r["text"] = ""      # 找框模式不带文字
        LOG.info("detect 页 %dx%d -> %d 框，%d ms", img.width, img.height,
                 len(out["regions"]), out["ms"])
        return out

    @app.post("/ocr")
    async def ocr(req: ImgReq):
        img = read_image(req.image)
        blocks, trace = await engine.extract_traced(img)
        out = regions_response(img, blocks, time.time(), trace=trace_to_b64(trace))
        LOG.info("ocr 页 %dx%d -> %d 框，%d ms，%d 字", img.width, img.height,
                 len(out["regions"]), out["ms"],
                 sum(len((r.get("text") or "")) for r in out["regions"]))
        return out

    @app.post("/detect/region")
    async def detect_region(req: RegionReq):
        return await _region(req, need_text=False)

    @app.post("/ocr/region")
    async def ocr_region(req: RegionReq):
        return await _region(req, need_text=True)

    async def _region(req: RegionReq, need_text: bool) -> dict:
        t0 = time.time()
        if len(req.box) != 4:
            raise HTTPException(400, "box 需要 4 个数")
        img = read_image(req.image)
        x1, y1, x2, y2 = [int(round(float(v))) for v in req.box]
        ox, oy = max(0, x1 - 12), max(0, y1 - 12)
        ex, ey = min(img.width, x2 + 12), min(img.height, y2 + 12)
        if ex - ox < 8 or ey - oy < 8:
            raise HTTPException(400, "区域太小")
        crop = img.crop((ox, oy, ex, ey))
        blocks, trace = await engine.extract_traced(crop)
        # 裁剪图坐标 → 原图坐标
        for b in blocks:
            b.box = [b.box[0] + ox, b.box[1] + oy, b.box[2] + ox, b.box[3] + oy]
            for c in b.columns:
                c.box = [c.box[0] + ox, c.box[1] + oy, c.box[2] + ox, c.box[3] + oy]
        out = regions_response(img, blocks, t0, input_img=crop,
                               trace=trace_to_b64(trace))
        out["region"] = {"box": [float(v) for v in req.box], "origin": [ox, oy]}
        if not need_text:
            for r in out["regions"]:
                r["text"] = ""
        LOG.info("%s 区域 %s -> %d 框，%d ms",
                 "ocr-region" if need_text else "detect-region",
                 [int(v) for v in req.box], len(out["regions"]), out["ms"])
        return out

    @app.post("/ocr/box")
    async def ocr_box(req: RegionReq):
        """框内识别：把这个框裁出来，走同一套 extract_columns。"""
        t0 = time.time()
        if len(req.box) != 4:
            raise HTTPException(400, "box 需要 4 个数")
        img = read_image(req.image)
        user = [float(v) for v in req.box]
        x1, y1 = max(0, int(user[0]) - 10), max(0, int(user[1]) - 10)
        x2, y2 = min(img.width, int(user[2]) + 10), min(img.height, int(user[3]) + 10)
        crop = img.crop((x1, y1, x2, y2))
        blocks, trace = await engine.extract_traced(crop)
        text = "".join(b.text for b in blocks)
        prob = min((c.prob for b in blocks for c in b.columns), default=0.0)
        _ms = int((time.time() - t0) * 1000)
        LOG.info("ocr-box %s -> %r（%d 字，prob=%.3f，%d ms）",
                 [int(v) for v in user], text[:60], len(text), prob, _ms)
        return {
            "width": img.width, "height": img.height,
            "ms": _ms,
            "count": 1,
            "regions": [{
                "box": user,
                "text": text,
                "prob": round(prob, 3),
                "lines": [c.text for b in blocks for c in b.columns if c.text],
                "linesInCrop": [list(b.box) for b in blocks],
                "blocks": [block_to_region(b) for b in blocks],
            }],
            "box": user,
            "algorithm": "mask-column",
            "input": to_jpeg_b64(crop),
            "trace": trace_to_b64(trace),
        }

    @app.post("/ocr/batch")
    async def ocr_batch(req: BatchReq):
        items = []
        for b64 in req.images:
            img = read_image(b64)
            items.append(regions_response(img, await engine.extract(img), time.time()))
        LOG.info("ocr-batch %d 张 -> %d 项", len(req.images), len(items))
        return {"items": items}

    return app


if __name__ == "__main__":
    # Windows 控制台/重定向默认 GBK，中文日志会变乱码；统一成 UTF-8。
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="漫画 OCR 服务（mask-column 算法）")
    ap.add_argument("--port", type=int, default=5009)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--use-gpu", action="store_true")
    ap.add_argument("--device", default=None, choices=["cpu", "cuda"])
    ap.add_argument("--log-level", default="info",
                    choices=["critical", "error", "warning", "info", "debug"],
                    help="uvicorn 日志级别（默认 info：打印启动和每个请求）")
    args = ap.parse_args()
    device = args.device or ("cuda" if args.use_gpu else "cpu")
    log_path = setup_logging(args.log_level.upper())
    LOG.info("=" * 60)
    LOG.info("OCR 服务启动 | device=%s | 端口=%s | MT=%s", device, args.port, MT)
    LOG.info("日志文件: %s", log_path)
    t0 = time.time()
    try:
        LOG.info("开始加载模型（首次会下载/读取权重，可能需要 1-2 分钟）")
        app = build_app(Engine(device))
        LOG.info("模型就绪，用时 %.1fs", time.time() - t0)
    except Exception:
        LOG.exception("模型加载失败，服务无法启动")
        raise
    LOG.info("开始监听 http://%s:%s", args.host, args.port)
    # 先探测端口：uvicorn 自己遇到 EADDRINUSE 会直接 SystemExit，日志里留不下原因。
    import socket
    _probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        _probe.bind((args.host, args.port))
        _probe.close()
    except OSError as e:
        LOG.error("端口 %s 已被占用，服务无法启动（%s）", args.port, e)
        LOG.error("  查看占用：netstat -ano | findstr :%s", args.port)
        LOG.error("  结束占用：taskkill /PID <PID> /F")
        raise SystemExit(3)
    finally:
        try: _probe.close()
        except Exception: pass

    # uvicorn 自己的访问日志交给上面的中间件，这里关掉避免重复。
    try:
        uvicorn.run(app, host=args.host, port=args.port,
                    log_level="warning", access_log=False)
    except SystemExit:
        raise
    except OSError as e:
        # 端口被占用最常见（Errno 10048），单独给可执行的建议
        if getattr(e, "errno", None) in (10048, 98) or "10048" in str(e):
            LOG.error("端口 %s 已被占用，无法启动。\n"
                      "  查看占用：netstat -ano | findstr :%s\n"
                      "  结束占用：taskkill /PID <PID> /F", args.port, args.port)
        else:
            LOG.exception("服务启动失败")
        raise
    except Exception:
        LOG.exception("服务异常退出")
        raise
