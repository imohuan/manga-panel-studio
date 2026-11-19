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
        return out

    @app.post("/ocr")
    async def ocr(req: ImgReq):
        img = read_image(req.image)
        blocks, trace = await engine.extract_traced(img)
        return regions_response(img, blocks, time.time(), trace=trace_to_b64(trace))

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
        return {
            "width": img.width, "height": img.height,
            "ms": int((time.time() - t0) * 1000),
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
        return {"items": items}

    return app


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="漫画 OCR 服务（mask-column 算法）")
    ap.add_argument("--port", type=int, default=5009)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--use-gpu", action="store_true")
    ap.add_argument("--device", default=None, choices=["cpu", "cuda"])
    args = ap.parse_args()
    device = args.device or ("cuda" if args.use_gpu else "cpu")
    print(f"[manga-ocr] device={device} algorithm=mask-column", flush=True)
    uvicorn.run(build_app(Engine(device)), host=args.host, port=args.port, log_level="warning")
