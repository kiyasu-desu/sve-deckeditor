/**
 * 主题卡池回归测试。
 *
 * 覆盖的 bug：PR-430SC（公主连结）在组卡时找不到。
 * 根因：主题池只看 card.box，而 PR 卡的 box 是 'PR'。
 * 另外灰姑娘女孩的 CSD02a/b/c 三个基本牌组盒一直没被收录。
 *
 * 做法：从 app.js 抽出真实的 cardInTheme / themeIdOf 源码执行，
 *       用真实的 data/cards.json 验证。
 */
import fs from 'node:fs';

const appSrc = fs.readFileSync('app.js', 'utf8');
const cards = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));

// 抽出 THEME_POOLS 定义与两个辅助函数
const poolsSrc = appSrc.match(/const THEME_POOLS = \[[\s\S]*?\];/);
const inThemeSrc = appSrc.match(/function cardInTheme\([\s\S]*?\n  \}/);
const themeIdSrc = appSrc.match(/function themeIdOf\([\s\S]*?\n  \}/);
if (!poolsSrc || !inThemeSrc || !themeIdSrc) {
  console.error('未能从 app.js 抽出主题判定代码');
  process.exit(1);
}
console.log('已从 app.js 抽出 THEME_POOLS / cardInTheme / themeIdOf\n');

const api = new Function(
  `${poolsSrc[0]}\n${inThemeSrc[0]}\n${themeIdSrc[0]}\nreturn { THEME_POOLS, cardInTheme, themeIdOf };`,
)();
const { THEME_POOLS, cardInTheme, themeIdOf } = api;

let fail = 0;
const ck = (ok, m) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${m}`); if (!ok) fail += 1; };
const byId = (id) => cards.find((c) => c.id === id);
const poolOf = (tid) => cards.filter((c) => cardInTheme(c, tid));

// ---------- 1. 数据完整性 ----------
console.log('── 1. cards.json 的 theme 字段 ──');
const withTheme = cards.filter((c) => c.theme);
ck(withTheme.length > 1000, `${withTheme.length} 张卡带 theme 字段`);
const badTheme = withTheme.filter((c) => !['uma', 'imas', 'pcr'].includes(c.theme));
ck(badTheme.length === 0, `theme 取值都合法${badTheme.length ? '（异常：' + badTheme.slice(0, 3).map((c) => c.id + '=' + c.theme).join(', ') + '）' : ''}`);

// ---------- 2. 各主题卡数 ----------
console.log('\n── 2. 各主题卡池大小 ──');
for (const t of THEME_POOLS) {
  const n = poolOf(t.id).length;
  ck(n > 300, `${t.name.padEnd(8)} ${n} 张`);
}

// ---------- 3. 用户报的 bug ----------
console.log('\n── 3. 回归：用户报的卡 ──');
const c430 = byId('PR-430SC');
ck(!!c430, 'PR-430SC 存在于卡表');
ck(c430 && cardInTheme(c430, 'pcr'), 'PR-430SC 属于公主连结卡池');
ck(c430 && themeIdOf(c430) === 'pcr', 'themeIdOf(PR-430SC) === pcr');
ck(c430 && c430.box === 'PR', '（它的 box 仍是 PR，说明不是靠盒号判的）');

// ---------- 4. 整批 PR 卡 ----------
console.log('\n── 4. PR 卡的主题归属 ──');
const pr = cards.filter((c) => String(c.box).toUpperCase() === 'PR');
const prThemed = pr.filter((c) => c.theme);
console.log(`   PR 卡共 ${pr.length} 张，其中 ${prThemed.length} 张有主题归属`);
const prByTheme = {};
for (const c of prThemed) prByTheme[c.theme] = (prByTheme[c.theme] || 0) + 1;
for (const k in prByTheme) console.log(`     ${k}: ${prByTheme[k]} 张`);
ck(prByTheme.pcr > 0, `公主连结有 ${prByTheme.pcr || 0} 张 PR 卡`);
ck(prByTheme.uma > 0, `赛马娘有 ${prByTheme.uma || 0} 张 PR 卡`);

// ---------- 5. CSD02 盒（灰姑娘女孩基本牌组）----------
console.log('\n── 5. 回归：CSD02a/b/c 盒 ──');
for (const box of ['CSD02a', 'CSD02b', 'CSD02c']) {
  const n = cards.filter((c) => c.box === box).length;
  const themed = cards.filter((c) => c.box === box && cardInTheme(c, 'imas')).length;
  ck(n > 0 && themed === n, `${box}: ${themed}/${n} 张归入灰姑娘女孩`);
}

// ---------- 6. 不该进主题池的卡 ----------
console.log('\n── 6. 反向检查：普通补充包的卡不应进主题池 ──');
let leaked = 0;
const samples = [];
for (const t of THEME_POOLS) {
  for (const c of poolOf(t.id)) {
    // 主题卡应当来自主题盒 / PR / 兵种带主题名
    const boxIsTheme = t.boxes.map((b) => b.toUpperCase()).includes(String(c.box).toUpperCase());
    if (!boxIsTheme && String(c.box).toUpperCase() !== 'PR') {
      const typeStartsWithTheme = ['赛马娘', '灰姑娘偶像', '公主连结'].some((p) => String(c.type2 || c.type || '').startsWith(p));
      if (!typeStartsWithTheme) { leaked += 1; if (samples.length < 5) samples.push(`${c.id} box=${c.box} → ${t.id}`); }
    }
  }
}
ck(leaked === 0, `主题池里没有来路不明的卡${leaked ? '（' + samples.join('; ') + '）' : ''}`);

// ---------- 7. 中立/职业卡不受影响 ----------
console.log('\n── 7. 主题外卡不受影响 ──');
const bp = byId('BP01-001SC');
ck(bp && !bp.theme, 'BP01-001SC（普通补充包）没有 theme 字段');
ck(bp && !cardInTheme(bp, 'pcr'), 'BP01-001SC 不属于公主连结');

console.log(`\n${fail === 0 ? '═══ 主题卡池测试全部通过 ═══' : `═══ 有 ${fail} 项失败 ═══`}`);
process.exitCode = fail ? 1 : 0;
