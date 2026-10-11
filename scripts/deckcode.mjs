/**
 * 卡组码工具：解码 / 编码 / 往返校验。
 *
 * 用法：
 *   node scripts/deckcode.mjs decode "<卡组码>"
 *   node scripts/deckcode.mjs encode '{"1":"赛马娘","2":881,"3":[...],"4":[...]}'
 *   node scripts/deckcode.mjs selftest          # 往返校验（随机生成卡组）
 *
 * 算法：AES-CBC + Pkcs7，key/IV 按 UTF-8 明文字节使用（非标准做法，必须用 CryptoJS）。
 * 已验证可产出官方 APP 可直接导入的卡组码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require(path.join(process.cwd(), 'lib', 'crypto-js.js'));

const KEY = 'kcrsJtKRaoxBQSaPD1qO/IWKza0AfzLauCv7RgEbPyM=';
const IV = 'g6rMfAsWbbacxpMyR7wGfA==';

export function encryptDeckCode(obj) {
  return C.AES.encrypt(JSON.stringify(obj), C.enc.Utf8.parse(KEY), {
    iv: C.enc.Utf8.parse(IV), mode: C.mode.CBC, padding: C.pad.Pkcs7,
  }).toString();
}

export function decryptDeckCode(code) {
  const dec = C.AES.decrypt(code.trim(), C.enc.Utf8.parse(KEY), {
    iv: C.enc.Utf8.parse(IV), mode: C.mode.CBC, padding: C.pad.Pkcs7,
  });
  const txt = dec.toString(C.enc.Utf8);
  if (!txt) throw new Error('解密失败：密钥或密文不匹配');
  return JSON.parse(txt);
}

/** 把 {sid: 张数} 展开成 shortId 数组 */
export const expand = (map) => {
  const a = [];
  for (const [sid, n] of Object.entries(map)) for (let i = 0; i < n; i += 1) a.push(Number(sid));
  return a;
};

/** 卡组码 → 可读结构（若本地有卡表则附上卡名） */
export function describe(obj) {
  let bySid = new Map();
  try {
    const cards = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
    bySid = new Map(cards.filter((c) => c.sid).map((c) => [Number(c.sid), c]));
  } catch (e) { /* 无卡表也能解结构 */ }

  const lines = [];
  lines.push(`卡池: ${obj['1']}`);
  const m = bySid.get(Number(obj['2']));
  lines.push(`主战者: sid ${obj['2']}${m ? `  ${m.name} (${m.id})` : ''}`);

  const dump = (arr, label) => {
    const g = new Map();
    for (const s of arr || []) g.set(s, (g.get(s) || 0) + 1);
    lines.push(`${label} ${(arr || []).length} 张，${g.size} 种：`);
    for (const [sid, n] of [...g.entries()].sort((a, b) => a[0] - b[0])) {
      const c = bySid.get(Number(sid));
      lines.push(`  x${n}  sid ${String(sid).padStart(5)}  ${c ? `${c.name} (${c.id})` : '（本地无数据）'}`);
    }
  };
  dump(obj['3'], '基础卡组');
  dump(obj['4'], '进化卡组');
  return lines.join('\n');
}

// ---------------- CLI ----------------
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'decode') {
  if (!arg) { console.error('用法: node scripts/deckcode.mjs decode "<卡组码>"'); process.exit(1); }
  const obj = decryptDeckCode(arg);
  console.log(describe(obj));
} else if (cmd === 'encode') {
  if (!arg) { console.error('用法: node scripts/deckcode.mjs encode \'{"1":...}\''); process.exit(1); }
  console.log(encryptDeckCode(JSON.parse(arg)));
} else if (cmd === 'selftest') {
  // 随机造卡组做往返校验
  let pass = 0;
  const N = 200;
  for (let i = 0; i < N; i += 1) {
    const obj = {
      1: ['赛马娘', '灰姑娘女孩', '公主连结', '精灵'][i % 4],
      2: 100 + i,
      3: Array.from({ length: 40 }, () => 1000 + Math.floor(Math.random() * 5000)),
      4: Array.from({ length: 10 }, () => 6000 + Math.floor(Math.random() * 500)),
    };
    const code = encryptDeckCode(obj);
    const back = decryptDeckCode(code);
    if (JSON.stringify(back) === JSON.stringify(obj)) pass += 1;
  }
  console.log(`往返校验: ${pass}/${N} 通过`);
  if (pass !== N) process.exitCode = 1;
} else {
  console.log(`卡组码工具

  node scripts/deckcode.mjs decode "<卡组码>"     解码为可读结构
  node scripts/deckcode.mjs encode '<json>'       编码为卡组码
  node scripts/deckcode.mjs selftest              往返校验`);
}
