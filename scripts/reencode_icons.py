"""把 GSF 的截断 PNG 用 PIL 解码后重编码为标准完整 PNG，供浏览器正常渲染。"""
import glob
import os

from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True

SRC = "sve-deckeditor/web/icons"
BAK = "sve-deckeditor/recon/icons_raw"

os.makedirs(BAK, exist_ok=True)

report = []
for f in sorted(glob.glob(os.path.join(SRC, "*.png"))):
    name = os.path.basename(f)
    # 备份原文件（仅首次）
    bak = os.path.join(BAK, name)
    if not os.path.exists(bak):
        with open(f, "rb") as fh:
            with open(bak, "wb") as bh:
                bh.write(fh.read())

    raw = open(f, "rb").read()
    raw_ok = raw[:4] == b"\x89PNG"

    try:
        im = Image.open(f)
        im.load()
        im = im.convert("RGBA")
        # 重新编码为标准 PNG，条带化让数据完整
        im.save(f, format="PNG", optimize=False)
        new = open(f, "rb").read()
        ok = new[:4] == b"\x89PNG" and new[-8:-4] == b"IEND"
        report.append((name, im.size, len(raw), len(new), ok))
    except Exception as exc:  # noqa: BLE001
        report.append((name, None, len(raw), 0, f"FAIL {type(exc).__name__}: {exc}"))

print(f"{'文件':32} {'尺寸':12} {'原大小':>9} {'新大小':>9}  结果")
for name, size, o, n, ok in report:
    sz = f"{size[0]}x{size[1]}" if size else "-"
    print(f"{name:32} {sz:12} {o:9} {n:9}  {'完整PNG' if ok is True else ok}")

bad = [r for r in report if r[4] is not True]
print(f"\n共 {len(report)} 张，异常 {len(bad)} 张")
if bad:
    print("异常清单:", [r[0] for r in bad])
