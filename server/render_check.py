"""检查图渲染：给 Agent 看的「原图 + 参考线 + 框标注」合成图。

在整个流程中的位置：
    canvas.mjs 的 /render 接口收到参数后调用本脚本（命令行传参，结果走 stdout）；
    public/render.html 是它的可视化调试页。用途：让 Agent 通过看图回答
    「框是否框对了文字、有没有漏框」——坐标刻度按原始像素标注，Agent 读图后
    直接给出像素坐标，无需换算。

两层压缩设计（体积从 946KB 压到 27KB 仍可读）：
    1. 底图：q（默认 35）+ scale（可 0.5）先把漫画原图压小压糊——Agent 只需要
       看清位置和大概文字；
    2. 叠加层：参考线、坐标刻度、框标签在低画质底图之上以高质量绘制（oq=88），
       线和数字始终锐利。

参数（JSON 字符串，来自 canvas.mjs /render）：
    session, page   会话名与页码（读 sessions/<会话>/<页>.jpg）
    grid/minor/major/labels/margin   参考线开关、细/粗间隔、是否标刻度、边距宽
    rect            裁剪区域 x1,y1,x2,y2（原始像素，可选）
    focus           着重框列表（橙色粗框强调，不影响输出范围）
    srcMode/selected 控制画哪些框（全部/只勾选/排除）
    colored, showText, lw            框颜色、是否写文字、线宽
    gray, q, scale, oq, zoom         灰度、底图质量、底图缩放、叠加质量、输出缩放

输出：JPEG 字节流写到 stdout（canvas.mjs 直接转发给浏览器/Agent）。
"""
import sys, json, io
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

def _sessions_root():
    """sessions 目录固定在数据根目录下的 sessions/。
    数据根：环境变量 STUDIO_DATA_DIR > settings.json 的 canvas.dataDir
    > 默认 %LOCALAPPDATA%/manga-panel-studio。与 canvas.mjs 保持同一来源。"""
    env = os.environ.get("STUDIO_DATA_DIR")
    if env:
        return Path(env)
    sf = (Path(os.environ.get("STUDIO_DATA_DIR")) if os.environ.get("STUDIO_DATA_DIR")
          else Path.home() / ".manga-panel-studio") / "settings.json"
    if sf.exists():
        try:
            canvas = json.loads(sf.read_text(encoding="utf-8")).get("canvas") or {}
            if canvas.get("dataDir"):
                return Path(canvas["dataDir"]) / "sessions"
        except Exception:
            pass
    local = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return Path(local) / "manga-panel-studio" / "sessions"

params = json.loads(sys.argv[1])
session = params['session']; page = params['page']
root = _sessions_root() / session
img = Image.open(root / (page + '.jpg')).convert('RGB')
W0, H0 = img.size

def istr(k, d=0):
    try: return int(float(params.get(k, d)))
    except: return int(d)

def fbool(k, d=False):
    v = params.get(k)
    if v is None: return d
    return str(v).lower() in ('1','true','yes','on')

gray = fbool('gray', True)
if gray: img = img.convert('L').convert('RGB')

# ---- 第 1 层：底图强压缩（agent 只需要大致坐标，画质不重要）----
base_q = max(15, min(80, istr('q', 35)))
scale = float(params.get('scale') or 1)
if scale and scale != 1:
    img = img.resize((int(W0 * scale), int(H0 * scale)), Image.LANCZOS)
W, H = img.size
buf = io.BytesIO()
img.save(buf, 'JPEG', quality=base_q)
buf.seek(0)
img = Image.open(buf).convert('RGB')     # 低画质底图，参考线之后画在上面

MARGIN = max(40, istr('margin', 64))

rect = None
rv = str(params.get('rect') or '').strip()
if rv:
    try:
        p = [float(x) for x in rv.split(',')]
        # rect 按原始分辨率解释，自动换算到 scale 后的底图坐标
        r2 = [int(p[0]*scale), int(p[1]*scale), int(p[2]*scale), int(p[3]*scale)]
        r2 = [max(0,r2[0]), max(0,r2[1]), min(W,r2[2]), min(H,r2[3])]
        if r2[2] > r2[0] and r2[3] > r2[1]:
            rect = r2
        else:
            sys.stderr.write('rect out of bounds after scale: ' + rv)
            sys.exit(2)
    except ValueError:
        sys.stderr.write('invalid rect: ' + rv)
        sys.exit(2)

draw = ImageDraw.Draw(img)

FOCUS_C = (255,140,0)
for seg in str(params.get('focus') or '').split(';'):
    seg = seg.strip()
    if not seg: continue
    try:
        p = [float(x) for x in seg.split(',')]
        if len(p) == 4 and p[2] > p[0] and p[3] > p[1]:
            draw.rectangle([v * scale for v in p], outline=FOCUS_C, width=max(3, istr('lw', 2) + 2))
    except: pass

grid = fbool('grid', True)
if grid:
    minor = istr('minor', 50) or 50
    major = istr('major', 100)
    for x in range(minor, W + 1, minor):
        is_major = major and x % major == 0
        c = (140,140,140) if is_major else (210,210,210)
        draw.line([(x, 0), (x, H)], fill=c, width=2 if is_major else 1)
    for y in range(minor, H + 1, minor):
        is_major = major and y % major == 0
        c = (140,140,140) if is_major else (210,210,210)
        draw.line([(0, y), (W, y)], fill=c, width=2 if is_major else 1)

if rect:
    img = img.crop((rect[0], rect[1], rect[2], rect[3]))
cw, ch = img.size

# ---- 第 2 层：边距 + 框/文字/坐标（清晰叠加，最后高质量保存）----
canvas = Image.new('RGB', (cw + MARGIN, ch + MARGIN), (16, 16, 16))
canvas.paste(img, (MARGIN, MARGIN))
d2 = ImageDraw.Draw(canvas)

try:
    # 字体：STUDIO_FONT > 常见中文字体候选 > load_default（不因缺字体 500）
    _font_path = os.environ.get("STUDIO_FONT")
    if not _font_path:
        for cand in (r'C:\\Windows\\Fonts\\msyh.ttc', r'C:\\Windows\\Fonts\\simhei.ttf',
                     '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'):
            if Path(cand).exists():
                _font_path = cand
                break
    f_major = ImageFont.truetype(_font_path, 15) if _font_path else ImageFont.load_default()
except: f_major = None

meta = json.loads((root / (page + '.json')).read_text(encoding='utf-8'))
regions = meta.get('regions') or []
mode = params.get('src_mode') or 'all'
idxs = [int(x) for x in str(params.get('idx') or '').split(',') if x.strip().lstrip('-').isdigit()]
COLORS = {'zoom': (255,60,60), 'auto': (60,200,90), 'manual': (80,160,255),
          'sfx': (255,200,40), 'ocr-box': (255,140,60), 'region': (200,120,255), '': (255,60,60)}
lw = istr('lw', 2) or 2
show_text = not fbool('no_text')
mono = fbool('mono_boxes')

def to_canvas(x, y):
    return (MARGIN + x - (rect[0] if rect else 0), MARGIN + y - (rect[1] if rect else 0))

for i, r in enumerate(regions):
    if mode == 'include' and i not in idxs: continue
    if mode == 'exclude' and i in idxs: continue
    b = r.get('box')
    if not b or len(b) != 4: continue
    x1, y1, x2, y2 = [float(v) * scale for v in b]
    if rect and (x2 < rect[0] or x1 > rect[2] or y2 < rect[1] or y1 > rect[3]): continue
    src = str(r.get('source') or '')
    color = (255,40,40) if mono else COLORS.get(src, (255,40,40))
    px1, py1 = to_canvas(x1, y1); px2, py2 = to_canvas(x2, y2)
    d2.rectangle([px1, py1, px2, py2], outline=color, width=lw)
    if show_text:
        label = '#' + str(i) + ' ' + str(r.get('text') or r.get('translation') or '')[:14]
        if label.strip('# '):
            tw = d2.textlength(label, font=f_major)
            d2.rectangle([px1, max(0, py1 - 18), px1 + tw + 8, py1], fill=(0,0,0))
            d2.text((px1 + 4, max(0, py1 - 17)), label, fill=(255,255,255), font=f_major)

if grid:
    minor = istr('minor', 50) or 50
    major = istr('major', 100)
    labels = fbool('labels', True)
    x0 = rect[0] if rect else 0
    y0 = rect[1] if rect else 0
    x1 = rect[2] if rect else W
    y1 = rect[3] if rect else H
    for x in range((x0 // minor) * minor, x1 + 1, minor):
        if x < x0: continue
        sx = to_canvas(x, 0)[0]
        is_major = major and x % major == 0
        d2.line([(sx, 0), (sx, MARGIN + ch)], fill=(120,120,120) if is_major else (80,80,80),
                width=2 if is_major else 1)
        if is_major and labels:
            d2.text((sx + 3, MARGIN - 18), str(int(x / scale)), fill=(255,255,255), font=f_major)
    for y in range((y0 // minor) * minor, y1 + 1, minor):
        if y < y0: continue
        sy = to_canvas(0, y)[1]
        is_major = major and y % major == 0
        d2.line([(0, sy), (MARGIN + cw, sy)], fill=(120,120,120) if is_major else (80,80,80),
                width=2 if is_major else 1)
        if is_major and labels:
            lbl = str(int(y / scale))
            timg = Image.new('RGBA', (60, 20), (0,0,0,0))
            td = ImageDraw.Draw(timg)
            td.text((0, 0), lbl, fill=(255,255,255), font=f_major)
            timg = timg.rotate(90, expand=True)
            canvas.paste(timg, (MARGIN - 24, sy - 10), timg)
    if rect and labels:
        d2.text((MARGIN - 44, 4), 'x' + str(int(x0 / scale)), fill=(180,180,180), font=f_major)
        d2.text((2, MARGIN - 18), 'y' + str(int(y0 / scale)), fill=(180,180,180), font=f_major)

zoom = float(params.get('zoom') or 1)
if zoom and zoom != 1:
    canvas = canvas.resize((int(canvas.width * zoom), int(canvas.height * zoom)), Image.LANCZOS)

# 最终保存高质量：参考线/文字锐利；整体依然小，因为底图已低画质
final_q = max(60, min(95, istr('oq', 88)))
buf2 = io.BytesIO()
canvas.save(buf2, 'JPEG', quality=final_q)
sys.stdout.buffer.write(buf2.getvalue())

