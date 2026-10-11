/** 结构自检：元素 id 引用完整、无重复 id、无残留引用。 */
import fs from 'node:fs';

const app = fs.readFileSync('sve-deckeditor/web/app.js', 'utf8');
const html = fs.readFileSync('sve-deckeditor/web/index.html', 'utf8');
let fail = 0;

const say = (ok, msg) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`); if (!ok) fail += 1; };

// 1. app.js 里 $('id') 引用的元素必须都存在
const used = new Set();
for (const m of app.matchAll(/\$\('([^']+)'\)/g)) used.add(m[1]);
const missing = [...used].filter((id) => !html.includes(`id="${id}"`));
say(missing.length === 0, `$() 引用的元素都存在（共 ${used.size} 个）`);
for (const id of missing) console.log(`      缺失: #${id}`);

// 2. HTML 里不能有重复 id
const all = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const dup = all.filter((x, i) => all.indexOf(x) !== i);
say(dup.length === 0, `HTML 无重复 id（共 ${all.length} 个）`);
for (const id of new Set(dup)) console.log(`      重复: #${id}`);

// 3. 关键流程元素齐全
const need = ['btnPreviewDeck', 'pvName', 'pvCount', 'pvCls', 'pvFollower', 'pvSpell',
  'pvAmulet', 'pvEvoCnt', 'pvMasterImg', 'pvCurveChart', 'pvBasic', 'pvEvo',
  'pvSave', 'pvImage', 'pvExport', 'pvClose', 'deckImage', 'diBody', 'diSaveImg', 'diClose'];
const miss2 = need.filter((id) => !html.includes(`id="${id}"`));
say(miss2.length === 0, `查看卡组 / 卡组图片 的必需元素齐全`);
for (const id of miss2) console.log(`      缺失: #${id}`);

// 4. 不应残留的旧引用
const stale = ['pvPool', 'pvMaster"', 'preview-meta', 'pv-info', 'preview-curve', 'curve-title'];
const found = stale.filter((s) => app.includes(s) || html.includes(s));
say(found.length === 0, '无旧结构残留引用');
for (const s of found) console.log(`      残留: ${s}`);

console.log(`\n${fail === 0 ? '结构自检通过' : `有 ${fail} 项失败`}`);
process.exitCode = fail === 0 ? 0 : 1;
