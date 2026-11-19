"""把框画在图上，作为历史记录的「输出图」。

在整个流程中的位置：
    canvas.mjs 每次完成一个识别/找框任务后调用本脚本（命令行传参，
    不走 HTTP）：输入 = 历史记录的「输入图」文件 + 框坐标 JSON，
    输出 = 同目录的「输出图」PNG（画上红色细框和序号）。
    前端历史卡片里看到的 输入图/输出图 对比就是这两张。

要点：只画细边框，不填充颜色，避免挡住文字；小图自动放大，线和字号跟着缩放；
外框标签用描边文字，任何底色上都看得清。

用法：python draw_boxes.py <输入图路径> <输出图路径> '<[[x1,y1,x2,y2], ...]>'
"""
import json
import sys
from PIL import Image, ImageDraw, ImageFont

src, dst, boxes_json = sys.argv[1:4]
boxes = json.loads(boxes_json)

img = Image.open(src).convert("RGB")

# 小图先放大，线宽和字号才不会糊成一片
UP = 1
short = min(img.width, img.height)
if short and short < 240:
    UP = max(1, min(4, int(240 / short) + 1))
    img = img.resize((img.width * UP, img.height * UP), Image.LANCZOS)

d = ImageDraw.Draw(img, "RGBA")
lw = max(1, round(min(img.width, img.height) / 120))
try:
    font = ImageFont.load_default()
except Exception:
    font = None

for i, b in enumerate(boxes):
    x1, y1, x2, y2 = [float(v) * UP for v in b]
    # 只描边，不填充
    d.rectangle([x1, y1, x2, y2], outline=(230, 40, 40, 255), width=lw)
    # 序号放在框外侧左上，带描边，避免与文字重叠
    if font is not None:
        tx, ty = x1, max(0, y1 - (lw * 6 + 2))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                d.text((tx + dx, ty + dy), str(i), font=font, fill=(255, 255, 255, 235))
        d.text((tx, ty), str(i), font=font, fill=(200, 30, 30, 255))

img.save(dst)
print(len(boxes))

