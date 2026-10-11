/**
 * 端到端验证：把解密出来的卡组内容重新加密，与官方 app 生成的卡组码对比。
 * 如果逐字符一致，说明我们的「生成」方向也完全正确（可离线产出官方可用码）。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../ref/crypto-js.js');

const KEY = 'kcrsJtKRaoxBQSaPD1qO/IWKza0AfzLauCv7RgEbPyM=';
const IV = 'g6rMfAsWbbacxpMyR7wGfA==';

function encryptDeckCode(obj) {
  return C.AES.encrypt(JSON.stringify(obj), C.enc.Utf8.parse(KEY), {
    iv: C.enc.Utf8.parse(IV), mode: C.mode.CBC, padding: C.pad.Pkcs7,
  }).toString();
}

const decks = JSON.parse(fs.readFileSync('sve-deckeditor/data/decks_decoded.json', 'utf8'));
const raw = JSON.parse(fs.readFileSync('sve-deckeditor/emu/card_groups.json', 'utf8'));
const codeByName = new Map((raw.items || []).map((it) => [it.name, it.code]));

let pass = 0;
for (const d of decks) {
  const official = codeByName.get(d.name);
  if (!official) { console.log(`${d.name}: 无官方码可比对`); continue; }
  const obj = { 1: d.box, 2: d.master, 3: d.basic, 4: d.evo };
  const mine = encryptDeckCode(obj);
  const same = mine === official;
  if (same) pass += 1;
  console.log(`${d.name.padEnd(8)} 官方长度=${official.length} 本机长度=${mine.length} => ${same ? '✅ 完全一致' : '❌ 不一致'}`);
  if (!same) {
    console.log('   官方:', official.slice(0, 80));
    console.log('   本机:', mine.slice(0, 80));
  }
}
console.log(`\n${pass}/${decks.length} 个卡组码逐字符一致`);
