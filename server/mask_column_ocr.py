"""漫画文字提取：mask → 文字块 → 竖排列 → 逐列 OCR。

在整个流程中的位置：
    ocr_service.py 是唯一的调用方（HTTP 接口层）；本文件是纯算法库，不含任何
    HTTP/IO，只吃 numpy 图、吐 TextBlock 列表。检测与 OCR 的模型都来自
    manga-image-translator，本文件只做「怎么把模型输出变成准确文字」这一层。

为什么这样切：
1) 检测器输出的是像素级 mask，对小字/竖排的召回很高（2048 已覆盖 91% 墨迹）。
2) 但框架内置的「mask → 多边形」会把整段竖排合成一个框，再整块送 OCR，
   OCR 模型只吃「一行文字条」，整块进去会混行、漏字。
3) 所以这里改成：mask 分块 → 每块按墨迹投影切列 → 每列单独送 OCR → 按阅读序拼接。

实测（00003.jpg）：整块方案字错率 46.6%，本方案 4.0%。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import List, Optional, Sequence

import cv2
import numpy as np

from manga_translator.config import Detector, Ocr, OcrConfig
from manga_translator.detection import dispatch as det_dispatch
from manga_translator.ocr import dispatch as ocr_dispatch
from manga_translator.utils import Quadrilateral


@dataclass
class TextColumn:
    """一列（或一行）文字。"""
    box: List[int]                      # 原图坐标 [x1, y1, x2, y2]
    text: str = ""
    prob: float = 0.0
    vertical: bool = True


@dataclass
class TextBlock:
    """一个文字块（气泡 / 段落），含若干列。"""
    box: List[int]
    columns: List[TextColumn] = field(default_factory=list)

    @property
    def text(self) -> str:
        """按阅读序拼接：竖排从右到左，横排从上到下。"""
        cols = sorted(self.columns, key=lambda c: -c.box[0] if c.vertical else c.box[1])
        return "".join(c.text for c in cols)


def _ink(gray: np.ndarray, th: int = 150) -> np.ndarray:
    return (gray < th).astype(np.float32)


def split_columns(gray: np.ndarray, min_w: int = 5, min_h: int = 18,
                  th: float = 0.05, gap: int = 2) -> List[tuple]:
    """按竖直墨迹投影切列。返回局部框 [(x1,y1,x2,y2), ...]。"""
    ink = _ink(gray)
    prof = ink.mean(axis=0) if ink.size else np.zeros(0, dtype=np.float32)
    on = prof > th
    spans, x, n = [], 0, len(on)
    while x < n:
        if not on[x]:
            x += 1
            continue
        s, empty = x, 0
        while x < n and empty < gap:
            empty = 0 if on[x] else empty + 1
            x += 1
        e = x - empty
        if e - s < min_w:
            continue
        rows = np.where(ink[:, s:e].sum(axis=1) > 0)[0]
        if rows.size == 0:
            continue
        y1, y2 = int(rows[0]), int(rows[-1] + 1)
        if y2 - y1 < min_h:
            continue
        spans.append((s, y1, e, y2))
    return spans


def split_rows(gray: np.ndarray, min_h: int = 5, min_w: int = 18,
               th: float = 0.05, gap: int = 2) -> List[tuple]:
    """按水平墨迹投影切行（横排文字用）。"""
    ink = _ink(gray)
    prof = ink.mean(axis=1) if ink.size else np.zeros(0, dtype=np.float32)
    on = prof > th
    spans, y, n = [], 0, len(on)
    while y < n:
        if not on[y]:
            y += 1
            continue
        s, empty = y, 0
        while y < n and empty < gap:
            empty = 0 if on[y] else empty + 1
            y += 1
        e = y - empty
        if e - s < min_h:
            continue
        colsx = np.where(ink[s:e, :].sum(axis=0) > 0)[0]
        if colsx.size == 0:
            continue
        x1, x2 = int(colsx[0]), int(colsx[-1] + 1)
        if x2 - x1 < min_w:
            continue
        spans.append((x1, s, x2, e))
    return spans


def mask_blocks(mask: np.ndarray, gray: np.ndarray, scale_x: float = 1.0,
                scale_y: float = 1.0, min_h: int = 30,
                min_area_ratio: float = 0.03) -> List[List[int]]:
    """mask 连通域 → 文字块框（坐标已换算回原图）。"""
    m = (mask > 100).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE,
                         cv2.getStructuringElement(cv2.MORPH_RECT, (7, 21)))
    n, _lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    out = []
    for i in range(1, n):
        x, y, w, h, area = (stats[i, 0], stats[i, 1], stats[i, 2],
                            stats[i, 3], stats[i, 4])
        if h < min_h or w < 5:
            continue
        if area / float(max(1, w * h)) < min_area_ratio:
            continue
        # mask 是在放大后的图上算的，先换算回原图再校验墨迹
        ox, oy = int(x * scale_x), int(y * scale_y)
        ow, oh = int(w * scale_x), int(h * scale_y)
        if gray[oy:oy + oh, ox:ox + ow].size == 0:
            continue
        out.append([ox, oy, ox + ow, oy + oh])
    return out


def _quad(box: Sequence[float], pad: int = 2) -> Quadrilateral:
    x1, y1, x2, y2 = [float(v) for v in box]
    return Quadrilateral(np.array([[x1 - pad, y1 - pad], [x2 + pad, y1 - pad],
                                   [x2 + pad, y2 + pad], [x1 - pad, y2 + pad]],
                                  dtype=np.float32), "", 1.0)


def _trace_overlay(image: np.ndarray, boxes, labels=None,
                   color=(235, 60, 60), lw: int = 2) -> np.ndarray:
    """把框画在原图副本上，供历史记录展示「模型看到了什么」。"""
    vis = image.copy()
    h, w = vis.shape[:2]
    lw = max(1, int(lw))
    for i, b in enumerate(boxes):
        x1, y1, x2, y2 = [int(round(float(v))) for v in b]
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w - 1, x2), min(h - 1, y2)
        if x2 <= x1 or y2 <= y1:
            continue
        cv2.rectangle(vis, (x1, y1), (x2, y2), color, lw)
        if labels is not None:
            txt = str(labels[i])
            ty = y1 - 4 if y1 > 14 else y1 + 14
            cv2.putText(vis, txt, (x1 + 2, ty), cv2.FONT_HERSHEY_SIMPLEX,
                        0.45, (255, 255, 255), 3, cv2.LINE_AA)
            cv2.putText(vis, txt, (x1 + 2, ty), cv2.FONT_HERSHEY_SIMPLEX,
                        0.45, color, 1, cv2.LINE_AA)
    return vis


def _trace_mask(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """检测 mask（检测分辨率）放大回原图，染红叠加。"""
    h, w = image.shape[:2]
    m = cv2.resize(mask, (w, h), interpolation=cv2.INTER_NEAREST)
    vis = image.copy()
    hot = m > 100
    if hot.any():
        tint = np.array([255, 70, 70], dtype=np.float32)
        vis[hot] = (vis[hot].astype(np.float32) * 0.4 + tint * 0.6).astype(np.uint8)
    return vis


def _trace_strips(image: np.ndarray, crops, panel_h: int = 150,
                  max_w: int = 2400) -> Optional[np.ndarray]:
    """把所有送进 OCR 的文字条拼成一张长图，每条左上角标序号。"""
    panels = []
    h_img, w_img = image.shape[:2]
    for i, box in enumerate(crops):
        x1, y1, x2, y2 = [int(round(float(v))) for v in box]
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w_img, x2), min(h_img, y2)
        if x2 <= x1 or y2 <= y1:
            continue
        crop = image[y1:y2, x1:x2]
        ch, cw = crop.shape[:2]
        scale = panel_h / float(max(1, ch))
        nw = max(14, min(220, int(round(cw * scale))))
        crop = cv2.resize(crop, (nw, panel_h), interpolation=cv2.INTER_AREA)
        crop = cv2.copyMakeBorder(crop, 4, 4, 4, 4, cv2.BORDER_CONSTANT,
                                  value=(232, 232, 232))
        label = str(i + 1)
        cv2.putText(crop, label, (5, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.42,
                    (255, 255, 255), 3, cv2.LINE_AA)
        cv2.putText(crop, label, (5, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.42,
                    (200, 40, 40), 1, cv2.LINE_AA)
        panels.append(crop)
    if not panels:
        return None
    rows, cur, curw = [], [], 0
    for p in panels:
        if cur and curw + p.shape[1] > max_w:
            rows.append(cur)
            cur, curw = [], 0
        cur.append(p)
        curw += p.shape[1] + 6
    if cur:
        rows.append(cur)
    width = max(sum(p.shape[1] + 6 for p in r) for r in rows) + 6
    height = sum(max(p.shape[0] for p in r) + 6 for r in rows) + 6
    canvas = np.full((height, width, 3), 246, dtype=np.uint8)
    y = 6
    for r in rows:
        x = 6
        for p in r:
            canvas[y:y + p.shape[0], x:x + p.shape[1]] = p
            x += p.shape[1] + 6
        y += max(p.shape[0] for p in r) + 6
    return canvas


async def extract_columns(image: np.ndarray, detector: str = "default",
                          ocr: str = "48px", detect_size: int = 2048,
                          det_device: str = "cpu", ocr_device: str = "cpu",
                          vertical_ratio: float = 1.15,
                          trace_out: Optional[dict] = None) -> List[TextBlock]:
    """完整流程：检测 mask → 分块 → 切列/行 → 逐条 OCR。

    trace_out：传入一个 dict 时，把每一步的可视化中间图写进去
    （mask 叠加、分块、切列、文字条拼图），供历史记录展示。
    """
    h, w = image.shape[:2]
    _, mask, _ = await det_dispatch(
        Detector(detector), image, detect_size, 0.3, 0.5, 2.0,
        False, False, False, False, det_device, False,
    )
    m = mask if mask.ndim == 2 else mask[..., 0]
    if trace_out is not None:
        trace_out["mask"] = _trace_mask(image, m)
    mh, mw = m.shape[:2]
    # 注意：mask 是「放大后的检测分辨率」，不是原图尺寸，必须按比例换算坐标
    scale_x, scale_y = w / float(mw), h / float(mh)
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    blocks = mask_blocks(m, gray, scale_x, scale_y)
    if trace_out is not None:
        trace_out["blocks"] = _trace_overlay(image, blocks,
                                             labels=range(len(blocks)),
                                             color=(60, 140, 235), lw=2)

    jobs = []      # (block_index, box)
    for bi, (bx1, by1, bx2, by2) in enumerate(blocks):
        sub = image[by1:by2, bx1:bx2]
        g = cv2.cvtColor(sub, cv2.COLOR_RGB2GRAY)
        vertical = (by2 - by1) > (bx2 - bx1) * vertical_ratio
        spans = split_columns(g) if vertical else split_rows(g)
        if not spans:
            spans = [(0, 0, bx2 - bx1, by2 - by1)]
        for (sx, sy, ex, ey) in spans:
            jobs.append((bi, [bx1 + sx, by1 + sy, bx1 + ex, by1 + ey], vertical))

    if trace_out is not None:
        trace_out["columns"] = _trace_overlay(
            image, [j[1] for j in jobs],
            labels=range(1, len(jobs) + 1), color=(40, 170, 110), lw=1)
        strips = _trace_strips(image, [j[1] for j in jobs])
        if strips is not None:
            trace_out["strips"] = strips
        trace_out["counts"] = {"blocks": len(blocks), "columns": len(jobs)}

    quads = [_quad(box) for _, box, _ in jobs]
    results = await ocr_dispatch(Ocr(ocr), image, quads, OcrConfig(prob=0.0),
                                 ocr_device, False) if quads else []

    # 重要：OCR 内部会按文字条宽度重排，返回顺序与输入不一致，
    # 必须按坐标回配，不能按顺序 zip。
    def _aabb(q):
        pts = np.asarray(q.pts, dtype=np.float32).reshape(-1, 2)
        return [float(pts[:, 0].min()), float(pts[:, 1].min()),
                float(pts[:, 0].max()), float(pts[:, 1].max())]

    got = [(_aabb(q), (getattr(q, "text", "") or "").strip(),
            float(getattr(q, "prob", 0.0))) for q in results]

    out = [TextBlock(box=b) for b in blocks]
    for (bi, box, vertical) in jobs:
        cx, cy = (box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0
        best, best_d = None, 1e18
        for rb, text, prob in got:
            if rb[0] - 6 <= cx <= rb[2] + 6 and rb[1] - 6 <= cy <= rb[3] + 6:
                d = abs((rb[0] + rb[2]) / 2 - cx) + abs((rb[1] + rb[3]) / 2 - cy)
                if d < best_d:
                    best, best_d = (text, prob), d
        if best is None:
            continue
        out[bi].columns.append(TextColumn(box=box, text=best[0], prob=best[1],
                                          vertical=vertical))
    return [b for b in out if b.columns]


async def extract_text(image: np.ndarray, **kwargs) -> List[dict]:
    """便捷接口：返回 [{box, text, columns}]。"""
    blocks = await extract_columns(image, **kwargs)
    return [{"box": b.box, "text": b.text,
             "columns": [{"box": c.box, "text": c.text, "prob": c.prob}
                         for c in b.columns]}
            for b in blocks]
