/** 结构自检（针对本仓库根目录）：元素 id 引用完整、无重复 id、必需元素齐全、移动端已接入。 */
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const mcss = fs.readFileSync('style-mobile.css', 'utf8');
let fail = 0;
const say = (ok, msg) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`); if (!ok) fail += 1; };

// 1. $() 引用的元素都要存在
const used = new Set();
for (const m of app.matchAll(/\$\('([^']+)'\)/g)) used.add(m[1]);
const missing = [...used].filter((id) => !html.includes(`id="${id}"`));
say(missing.length === 0, `$() 引用的元素都存在（共 ${used.size} 个）`);
for (const id of missing) console.log(`      缺失: #${id}`);

// 2. 无重复 id
const all = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const dup = [...new Set(all.filter((x, i) => all.indexOf(x) !== i))];
say(dup.length === 0, `HTML 无重复 id（共 ${all.length} 个）`);
for (const id of dup) console.log(`      重复: #${id}`);

// 3. 关键元素齐全
const need = ['grid', 'btnMyDecks',
  'btnFilterBall', 'btnFiltersClose', 'btnDeckBall', 'fabBasic', 'fabEvo', 'pvClear', 'pvName', 'pvCountBasic', 'pvCountEvo', 'pvCls', 'pvCurveChart',
  'pvBasic', 'pvEvo', 'pvSave', 'pvImage', 'pvExport', 'pvClose', 'deckImage',
  'diBody', 'diSaveImg', 'diClose', 'myDecks', 'myList', 'wizard', 'poolList',
  'masterList', 'wizCancel', 'wizOk'];
const miss2 = need.filter((id) => !html.includes(`id="${id}"`));
say(miss2.length === 0, '必需元素齐全');
for (const id of miss2) console.log(`      缺失: #${id}`);

// 4. 移动端已接入
say(html.includes('style-mobile.css'), 'index.html 引入移动端样式');
say(/\.qty-overlay/.test(mcss), '移动端样式含数量浮层');
say(app.includes('function attachQtyOverlay'), 'app.js 含浮层实现');
say(app.includes('IS_TOUCH'), 'app.js 含触摸设备判定');
say(!html.includes('id="qty"'), '旧的弹层已移除');

// 5. 无根绝对路径（GitHub Pages 子路径必需）
say(!/(href|src)="\//.test(html), 'HTML 无根绝对路径');

console.log(`\n${fail === 0 ? '结构自检通过' : `有 ${fail} 项失败`}`);
process.exitCode = fail ? 1 : 0;
