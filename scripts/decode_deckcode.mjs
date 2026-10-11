/**
 * 用逆向出的算法解密 app 卡组码。
 *
 * 算法（还原自 bundle 的 decryGroupCode / encryptAES）：
 *   AES.decrypt(base64(code), Utf8.parse(KEY), { iv: Utf8.parse(IV), mode: CBC, padding: Pkcs7 })
 * 注意 KEY/IV 是当作普通字符串（UTF-8 字节）使用，不是 base64 解码，因此必须用 CryptoJS 复现。
 *
 * 用法: node decode_deckcode.mjs [code 或 card_groups.json]
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../ref/crypto-js.js');

const KEY = 'kcrsJtKRaoxBQSaPD1qO/IWKza0AfzLauCv7RgEbPyM=';
const IV = 'g6rMfAsWbbacxpMyR7wGfA==';

let code = process.argv[2] || '';
if (!code) {
  const raw = JSON.parse(fs.readFileSync('sve-deckeditor/emu/card_groups.json', 'utf8'));
  const item = (raw.items || [])[0];
  if (!item) throw new Error('no deck in card_groups.json');
  code = item.code;
  console.log('deck:', item.name, 'id:', item.id, 'code length:', code.length);
}

// 规范化 base64（与 decryGroupCode 一致）
const norm = C.enc.Base64.stringify(C.enc.Base64.parse(code));
const dec = C.AES.decrypt(norm, C.enc.Utf8.parse(KEY), {
  iv: C.enc.Utf8.parse(IV),
  mode: C.mode.CBC,
  padding: C.pad.Pkcs7,
});
let plain;
try {
  plain = dec.toString(C.enc.Utf8);
} catch (e) {
  console.error('decrypt failed:', e.message);
  process.exit(1);
}
console.log('\n--- raw JSON ---');
console.log(plain);

let obj;
try {
  obj = JSON.parse(plain);
} catch (e) {
  console.error('not JSON:', e.message);
  process.exit(1);
}
console.log('\n--- parsed ---');
console.log('class (1):', obj['1']);
console.log('master shortId (2):', obj['2']);
const basic = obj['3'] || [];
const evo = obj['4'] || [];
console.log('basic shortIds (3):', basic.length, JSON.stringify(basic));
console.log('evo shortIds (4):', evo.length, JSON.stringify(evo));
console.log('total cards:', basic.length + evo.length);

// 与内存里提取到的 shortId 样本对照（局部表）
try {
  const sample = JSON.parse(fs.readFileSync('sve-deckeditor/data/shortid.json', 'utf8'));
  const rev = new Map(Object.entries(sample).map(([k, v]) => [v, k]));
  const named = [...basic, ...evo].map((s) => `${s}=${rev.get(s) || '?'}`);
  console.log('\nresolved against partial shortId table:', named.join(' '));
} catch (e) { /* ignore */ }
