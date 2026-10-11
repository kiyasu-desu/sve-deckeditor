"""按 v42 的 CSS 规则模拟渲染职业按钮网格，验证图标不再被裁。"""
import glob
import os

from PIL import Image, ImageDraw, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True

# 与 style.css 一致的常量（v43：固定 64x64 正方形盒子 + object-fit: contain）
TILE_W = 150          # 单块宽度（近似）
ICON_H = 82           # .pt-iconwrap 高度
BOX = 64              # .pt-icon 固定 64x64
NAME_H = 26           # .pt-name 高度
GAP = 8
COLS = 4

# 职业顺序（与 app.js 的排序一致）
ORDER = [
    ("精灵", "01"), ("皇家护卫", "02"), ("巫师", "03"), ("龙族", "04"),
    ("梦魇", "05"), ("主教", "06"), ("赛马娘", "07"), ("灰姑娘女孩", "08"),
    ("公主连结", "09"),
]

rows = (len(ORDER) + COLS - 1) // COLS
W = COLS * TILE_W + (COLS + 1) * GAP
H = rows * (ICON_H + NAME_H) + (rows + 1) * GAP

sheet = Image.new("RGB", (W, H), (17, 21, 27))
draw = ImageDraw.Draw(sheet)

print("按 CSS 规则模拟缩放：")
for i, (name, idx) in enumerate(ORDER):
    col = i % COLS
    row = i // COLS
    x0 = GAP + col * (TILE_W + GAP)
    y0 = GAP + row * (ICON_H + NAME_H + GAP)

    # tile 背景 + 边框
    draw.rounded_rectangle([x0, y0, x0 + TILE_W, y0 + ICON_H + NAME_H],
                           radius=8, fill=(35, 42, 52), outline=(70, 80, 95), width=2)

    f = f"sve-deckeditor/web/icons/classButton{idx}.on.png"
    if not os.path.exists(f):
        print(f"  {name}: 缺图")
        continue
    try:
        im = Image.open(f).convert("RGBA")
        im.load()
        ow, oh = im.size
    except Exception as exc:
        # GSF 图片普遍被截断，PIL 容忍度低于浏览器；退回用先前的有效副本
        print(f"  {name}: PIL 无法解码（{type(exc).__name__}），跳过绘制")
        continue

    # 模拟 object-fit: contain 到 64x64 正方形盒子
    scale = min(BOX / ow, BOX / oh)
    nw, nh = max(1, round(ow * scale)), max(1, round(oh * scale))
    scaled = im.resize((nw, nh), Image.LANCZOS)

    # flex 居中
    px = x0 + (TILE_W - nw) // 2
    py = y0 + (ICON_H - nh) // 2
    bg = Image.new("RGBA", scaled.size, (0, 0, 0, 0))
    bg.alpha_composite(scaled)
    sheet.paste(bg, (px, py), bg)

    clipped = nh > ICON_H or nw > TILE_W or nh > BOX or nw > BOX
    print(f"  {name:6} 原图 {ow}x{oh} -> 显示 {nw}x{nh}  盒子 {BOX}x{BOX}  {'裁切!' if clipped else '完整'}")

    # 名称条
    draw.rectangle([x0 + 2, y0 + ICON_H, x0 + TILE_W - 2, y0 + ICON_H + NAME_H - 2], fill=(22, 26, 33))

out = "sve-deckeditor/recon/wizard_preview.png"
sheet.save(out)
print("\n预览图 ->", out)
