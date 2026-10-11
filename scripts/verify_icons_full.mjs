/** 验证界面实际用到的 9 张职业图标是否都能 100% 渲染。 */
import fs from 'node:fs';
import zlib from 'node:zlib';

function inflateLenient(data) {
  return new Promise((resolve) => {
    const chunks = [];
    const inf = zlib.createInflate();
    inf.on('data', (c) => chunks.push(c));
    inf.on('end', () => resolve(Buffer.concat(chunks)));
    inf.on('error', () => resolve(Buffer.concat(chunks)));
    inf.end(data);
  });
}

async function ratio(buf) {
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const ch = buf[25] === 6 ? 4 : buf[25] === 2 ? 3 : 1;
  const idats = [];
  let pos = 8;
  let complete = false;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) break;
    const end = pos + 8 + len + 4;
    if (end > buf.length) { idats.push(buf.subarray(pos + 8, buf.length)); break; }
    if (type === 'IDAT') idats.push(buf.subarray(pos + 8, pos + 8 + len));
    if (type === 'IEND') { complete = true; break; }
    pos = end;
  }
  const out = await inflateLenient(Buffer.concat(idats));
  const stride = 1 + w * ch;
  return { w, h, lines: Math.floor(out.length / stride), complete };
}

const ORDER = [
  ['精灵', 1], ['皇家护卫', 2], ['巫师', 3], ['龙族', 4], ['梦魇', 5],
  ['主教', 6], ['赛马娘', 7], ['灰姑娘女孩', 8], ['公主连结', 9],
];

console.log('界面用到的 9 张图标：\n');
let pass = 0;
for (const [name, i] of ORDER) {
  const f = `sve-deckeditor/web/icons/classButton${String(i).padStart(2, '0')}.on.png`;
  if (!fs.existsSync(f)) { console.log(`  ${name.padEnd(6)} 缺文件`); continue; }
  const r = await ratio(fs.readFileSync(f));
  const pct = ((r.lines / r.h) * 100).toFixed(1);
  const ok = r.lines >= r.h;
  if (ok) pass += 1;
  console.log(`  ${name.padEnd(6)} ${r.w}x${r.h}  ${r.lines}/${r.h} 行 (${pct}%)  结构${r.complete ? '完整' : '截断'}  ${ok ? '完全可渲染' : '底部缺失!'}`);
}
console.log(`\n${pass}/${ORDER.length} 张能完整渲染`);
