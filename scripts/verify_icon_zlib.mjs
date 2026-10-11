/** 权威验证：zlib 解压 IDAT 是否成功、解出的像素量是否与尺寸匹配。 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const DIR = 'sve-deckeditor/web/icons';

function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ok: false, why: '非 PNG' };
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const idats = [];
  let pos = 8;
  let sawEnd = false;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) return { ok: false, why: `非法 chunk @${pos}`, w, h };
    const end = pos + 8 + len + 4;
    if (end > buf.length) return { ok: false, why: `越界 @${pos}`, w, h };
    if (type === 'IDAT') idats.push(buf.subarray(pos + 8, pos + 8 + len));
    if (type === 'IEND') { sawEnd = true; break; }
    pos = end;
  }
  if (!sawEnd) return { ok: false, why: '缺 IEND', w, h };
  try {
    const raw = zlib.inflateSync(Buffer.concat(idats));
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
    const expect = h * (1 + w * channels);
    return {
      ok: true, w, h, bitDepth, colorType, raw: raw.length, expect,
      match: raw.length === expect,
    };
  } catch (e) {
    return { ok: false, why: 'zlib: ' + e.message, w, h };
  }
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.png')).sort();
let pass = 0;
console.log('zlib 解压验证（成功即代表浏览器可完整渲染）：');
for (const f of files) {
  const r = decodePng(fs.readFileSync(`${DIR}/${f}`));
  if (r.ok && r.match) pass += 1;
  const detail = r.ok
    ? `${r.w}x${r.h} 颜色类型${r.colorType} 解出${r.raw}B 期望${r.expect}B ${r.match ? '匹配' : '不匹配'}`
    : r.why;
  console.log(`  ${f.padEnd(26)} ${(r.ok && r.match) ? '通过' : '失败'}  ${detail}`);
}
console.log(`\n${pass}/${files.length} 通过（可被浏览器完整渲染）`);
