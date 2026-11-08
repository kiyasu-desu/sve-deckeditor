/**
 * 验证「饱和度门控」的右下角修补算法（像素级）。
 *
 * 从 app.js 抽出真实循环，用可预测的合成图像验证：
 *   - 高饱和像素（噪点）被替换成右上角的镜像像素
 *   - 低饱和灰白像素（版权文字）原样保留 —— 这是本次修复的关键
 *   - 位置对应关系是垂直翻转
 */
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const m = app.match(/const src = ctx\.getImageData\(w - cw, 0, cw, ch\);[\s\S]*?\n      ctx\.putImageData\(dst, w - cw, h - ch\);/);
if (!m) { console.error('抽不到核心循环'); process.exit(1); }
console.log('已抽出核心算法，长度', m[0].length, '字符\n');

let fail = 0;
const ck = (ok, msg) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`); if (!ok) fail += 1; };

const W = 200;
const H = 200;
const CW = 40;
const CH = 20;
const HALF = W - CW / 2;      // 修复框内「文字区」与「噪点区」的分界

/** 合成图：右上角源=绿；右下角左半=灰(模拟文字)，右半=蓝(模拟噪点) */
function makeImage() {
  const buf = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      let r = 10; let g = 10; let b = 10;
      const inRight = x >= W - CW;
      if (inRight && y < CH) { r = 0; g = 255; b = 0; }
      else if (inRight && y >= H - CH) {
        if (x < HALF) { r = 128; g = 128; b = 128; }
        else { r = 0; g = 0; b = 255; }
      }
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return buf;
}

const ctx = {
  data: null,
  getImageData(sx, sy, sw, sh) {
    const out = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y += 1) {
      for (let x = 0; x < sw; x += 1) {
        const si = ((sy + y) * W + (sx + x)) * 4;
        const di = (y * sw + x) * 4;
        out[di] = ctx.data[si]; out[di + 1] = ctx.data[si + 1];
        out[di + 2] = ctx.data[si + 2]; out[di + 3] = ctx.data[si + 3];
      }
    }
    return { data: out, width: sw, height: sh };
  },
  putImageData(d, dx, dy) {
    for (let y = 0; y < d.height; y += 1) {
      for (let x = 0; x < d.width; x += 1) {
        const si = (y * d.width + x) * 4;
        const di = ((dy + y) * W + (dx + x)) * 4;
        ctx.data[di] = d.data[si]; ctx.data[di + 1] = d.data[si + 1];
        ctx.data[di + 2] = d.data[si + 2]; ctx.data[di + 3] = d.data[si + 3];
      }
    }
  },
};

const before = makeImage();
ctx.data = Uint8ClampedArray.from(before);

const w = W; const h = H; const cw = CW; const ch = CH;
new Function('ctx', 'w', 'h', 'cw', 'ch', m[0])(ctx, w, h, cw, ch);
const after = ctx.data;

const px = (buf, x, y) => { const i = (y * W + x) * 4; return [buf[i], buf[i + 1], buf[i + 2]]; };
const near = (a, b, tol = 3) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;

console.log('── 验证 ──');
ck(near(px(after, W - 1, H - 1), [0, 255, 0]), `噪点(蓝)被替换为源(绿)  实际 ${px(after, W - 1, H - 1)}`);
ck(near(px(after, W - CW, H - 1), [128, 128, 128]), `文字(灰)保留原样  实际 ${px(after, W - CW, H - 1)}`);
ck(near(px(after, W - CW + 2, H - 5), [128, 128, 128]), '文字区域多行都保留');
ck(near(px(after, W - 1, H - CH), [0, 255, 0]), '噪点区最上行也被替换');
ck(near(px(after, W - CW - 2, H - 1), [10, 10, 10]), '修复框左侧未受影响');
ck(near(px(after, W - 1, 0), [0, 255, 0]), '右上角源区域保持原样');

let textTouched = 0;
for (let y = H - CH; y < H; y += 1) {
  for (let x = W - CW; x < HALF; x += 1) {
    if (!near(px(after, x, y), [128, 128, 128])) textTouched += 1;
  }
}
ck(textTouched === 0, `文字区域 ${(CW / 2) * CH} 个像素全部保留（被改 ${textTouched} 个）`);

console.log(`\n${fail === 0 ? '═══ 饱和度门控算法验证通过 ═══' : `═══ 有 ${fail} 项失败 ═══`}`);
process.exitCode = fail ? 1 : 0;
