"""Build versioned WebP card thumbnails for the static site."""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPException
import io
import json
from pathlib import Path
import re
import struct
import sys
import time
import zlib
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from PIL import Image, ImageFile


ROOT = Path(__file__).resolve().parents[1]
CDN = "https://betasystem.gsf.netease.com/"
ASSET_KEY = re.compile(r"[a-f0-9]{32}\.(?:jpg|png)")
THUMB_PATH = Path("data/card-thumbs/v1")
WIDTH = 256
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_END = b"\x00\x00\x00\x00IEND\xae\x42\x60\x82"
ImageFile.LOAD_TRUNCATED_IMAGES = True


def source_bytes(raw):
    if raw.startswith((b"\xff\xd8\xff", PNG_SIGNATURE)):
        return raw
    start = min((i for marker in (b"/9j/", b"iVBORw0KGgo")
                 if (i := raw.find(marker)) >= 0), default=-1)
    if start < 0:
        raise ValueError("GSF image signature missing")
    b64 = re.sub(rb"[^a-zA-Z0-9+/=]", b"", raw[start:])
    return base64.b64decode(b64 + b"=" * (-len(b64) % 4))


def normalize_png(data):
    # GSF PNGs can end with junk bytes after IDAT or a partially written last chunk.
    pos = len(PNG_SIGNATURE)
    has_pixels = False
    while pos + 8 <= len(data):
        size, kind = struct.unpack_from(">I4s", data, pos)
        end = pos + 12 + size
        if not kind.isalpha():
            break
        if end > len(data):
            if kind == b"IDAT":
                pixels = data[pos + 8:pos + 8 + size]
                chunk = kind + pixels
                length = struct.pack(">I", len(pixels))
                crc = struct.pack(">I", zlib.crc32(chunk))
                return data[:pos] + length + chunk + crc + PNG_END
            break
        if kind == b"IEND":
            return data[:end]
        has_pixels |= kind == b"IDAT"
        pos = end
    return data[:pos] + PNG_END if has_pixels else data


def repair_corner(image):
    # Match the browser's saturation gate, including the copyright text.
    width, height = image.size
    if width < 200 or height < 200:
        return
    cw = max(32, round(width * .086))
    ch = max(18, round(height * .035))
    x0, y0 = width - cw, height - ch
    pixels = image.load()
    for y in range(ch):
        for x in range(x0, width):
            dst = pixels[x, y0 + y]
            saturation = max(dst[:3]) - min(dst[:3])
            if saturation <= 30:
                continue
            src = pixels[x, ch - 1 - y]
            alpha = min(1, (saturation - 30) / 25)
            channels = tuple(round(d + (s - d) * alpha) for d, s in zip(dst[:3], src[:3]))
            pixels[x, y0 + y] = channels + dst[3:]


def make_thumbnail(raw):
    data = source_bytes(raw)
    if data.startswith(PNG_SIGNATURE):
        data = normalize_png(data)
    with Image.open(io.BytesIO(data)) as source:
        image = source.convert("RGBA" if "A" in source.getbands() or "transparency" in source.info else "RGB")
    repair_corner(image)
    image.thumbnail((WIDTH, max(1, round(image.height * WIDTH / image.width))), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    image.save(out, "WEBP", quality=82, method=4)
    return out.getvalue()


def download(key):
    for attempt in range(3):
        try:
            with urlopen(CDN + key, timeout=25) as response:
                return response.read()
        except HTTPError as exc:
            if attempt == 2 or (exc.code not in (408, 429) and exc.code < 500):
                raise
        except (URLError, TimeoutError, HTTPException):
            if attempt == 2:
                raise
        time.sleep(2 ** attempt)


def write_atomic(path, contents):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(contents)
    tmp.replace(path)


def asset_keys(cards, pool=None, limit=None):
    if pool:
        cards = (card for card in cards if card.get("cls") in (pool, "中立"))
    keys = (card.get("md5", "") + (card.get("imgExt") or ".jpg") for card in cards if card.get("md5"))
    return list(dict.fromkeys(key for key in keys if ASSET_KEY.fullmatch(key)))[:limit]


def build(site, cache, keys, jobs):
    output = site / THUMB_PATH
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)

    def build_one(key):
        filename = key + ".webp"
        cached = cache / filename
        reused = cached.is_file()
        try:
            if not reused:
                local = ROOT / ".imgcache" / (key[:32] + ".jpg")
                thumbnail = None
                if local.is_file():
                    try:
                        thumbnail = make_thumbnail(local.read_bytes())
                    except (OSError, ValueError):
                        pass
                write_atomic(cached, thumbnail if thumbnail else make_thumbnail(download(key)))
            target = output / filename
            if not target.is_file() or target.stat().st_size != cached.stat().st_size:
                write_atomic(target, cached.read_bytes())
            return key, reused, target.stat().st_size, None
        except (OSError, ValueError, HTTPException) as exc:
            return key, False, 0, exc

    available = []
    reused_count = total_bytes = errors = 0
    with ThreadPoolExecutor(max_workers=jobs) as executor:
        for i, (key, reused, byte_count, error) in enumerate(executor.map(build_one, keys), 1):
            if error is None:
                available.append(key)
                reused_count += reused
                total_bytes += byte_count
            else:
                errors += 1
                if errors <= 10:
                    print(f"Thumbnail {key}: {error}", file=sys.stderr, flush=True)
            if i % 500 == 0:
                print(f"Processed {i}/{len(keys)} cards", flush=True)
    write_atomic(output / "manifest.json",
                 json.dumps(available, separators=(",", ":")).encode("ascii"))
    print(f"Thumbnails: {len(available)}/{len(keys)} ({reused_count} reused, "
          f"{errors} fallback to original), {total_bytes / 1048576:.1f} MiB", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-dir", type=Path, default=ROOT)
    parser.add_argument("--cache-dir", type=Path, default=ROOT / ".imgcache/card-thumbs-v1")
    parser.add_argument("--class-pool", help="Build one class and Neutral for local testing.")
    parser.add_argument("--limit", type=int, help="Limit the number of thumbnails for local testing.")
    parser.add_argument("--jobs", type=int, default=8)
    args = parser.parse_args()
    if args.jobs < 1 or (args.limit is not None and args.limit < 1):
        parser.error("--jobs and --limit must be positive")
    cards = json.loads((args.site_dir / "data/cards.json").read_text(encoding="utf-8"))
    build(args.site_dir, args.cache_dir, asset_keys(cards, args.class_pool, args.limit), args.jobs)


if __name__ == "__main__":
    main()
