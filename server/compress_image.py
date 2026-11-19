"""把一张图片压成 JPEG（ffmpeg 不可用时的兜底，只给 canvas.mjs 调用）。

为什么单独有它：历史记录里曾经出现「PNG 内容配 .jpg 扩展名」的图，
浏览器按 JPEG 解码就直接裂开。ffmpeg 参数写错也不会报错，所以这里用 PIL
再兜一层，保证落盘的永远是真正的 JPEG。

用法：python compress_image.py <输入> <输出.jpg> [最大边长]
"""
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
max_side = int(sys.argv[3]) if len(sys.argv) > 3 else 1400

img = Image.open(src)
if img.mode not in ("RGB", "L"):
    img = img.convert("RGB")
if img.mode == "L":
    img = img.convert("RGB")
if max(img.size) > max_side:
    k = max_side / float(max(img.size))
    img = img.resize((max(1, int(img.width * k)), max(1, int(img.height * k))),
                     Image.LANCZOS)
img.save(dst, "JPEG", quality=82, optimize=True)
print(f"{img.width}x{img.height}")
