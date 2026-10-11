/**
 * 提交前凭据扫描：确保仓库内没有任何账号/密钥/隐私信息。
 * 扫描整个 dist/ 目录的文本与二进制文件。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:\\code\\MyCode\\sve-tool\\dist';

// 高风险特征：一旦命中就绝对不允许提交
const BLOCK = [
  { re: /«REDACTED-APPKEY»/, why: 'NetEase appKey' },
  { re: /api-sve\.nie\.netease\.com/, why: '官方 API 地址（可能含签名逻辑）' },
  { re: /udid/i, why: 'udid 字段' },
  { re: /\budid\b\s*[:=]/i, why: 'udid 赋值' },
  { re: /«REDACTED-UID»/, why: '用户 uid' },
  { re: /«REDACTED-NICK»/, why: '用户昵称' },
  { re: /BEGIN [A-Z ]*PRIVATE KEY/, why: '私钥' },
  { re: /ssh-ed25519\s+AAAA/, why: 'SSH 公钥' },
  { re: /«REDACTED-KEYNAME»|«REDACTED-KEYNAME»/, why: '私钥文件名' },
  { re: /password\s*[:=]\s*['"][^'"]+/i, why: '明文口令' },
  { re: /token\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}/i, why: '疑似 token' },
  { re: /ghp_[A-Za-z0-9]{20,}/, why: 'GitHub PAT' },
  { re: /github_pat_/, why: 'GitHub PAT (fine-grained)' },
  { re: /«REDACTED-QQ»@qq\.com/, why: '个人邮箱' },
  { re: /«REDACTED-QQ»/, why: '个人 QQ 号' },
];

// 提示级：需人工确认
const WARN = [
  { re: /shadowverse|copyright|netease/i, why: '厂商名称（正常，仅提示）' },
  // GitHub 用户名本身就是公开信息（仓库 URL / Pages 域名都含它），只作提示
  { re: /kiyasu/i, why: 'GitHub 用户名（公开信息，仅提示）' },
];

const files = [];
const SKIP = new Set([
  path.join(ROOT, '.gitignore'),
  path.join(ROOT, 'scripts', 'scan_secrets.mjs'),   // 本文件自身含特征串，跳过
]);
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (SKIP.has(p)) continue;
    if (e.name === '.git') continue;
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
}(ROOT));

console.log(`扫描 ${files.length} 个文件\n`);

const hits = [];
const warns = [];
for (const f of files) {
  const buf = fs.readFileSync(f);
  const rel = f.replace(ROOT + path.sep, '');
  // 图片按二进制读，但要检查其中是否嵌了文本元数据
  const text = buf.toString('utf8');
  for (const b of BLOCK) {
    const m = text.match(b.re);
    if (m) hits.push({ file: rel, why: b.why, sample: m[0].slice(0, 60) });
  }
  for (const w of WARN) {
    const m = text.match(w.re);
    if (m) warns.push({ file: rel, why: w.why, sample: m[0].slice(0, 60) });
  }
}

console.log('=== 阻断级命中（必须为 0）===');
if (!hits.length) console.log('  无 ✓');
else for (const h of hits) console.log(`  ✗ ${h.file}: ${h.why} -> ${JSON.stringify(h.sample)}`);

console.log('\n=== 提示级命中（需人工确认）===');
if (!warns.length) console.log('  无');
else {
  const agg = new Map();
  for (const w of warns) {
    const k = `${w.why} -> ${JSON.stringify(w.sample)}`;
    agg.set(k, (agg.get(k) || 0) + 1);
  }
  for (const [k, n] of agg) console.log(`  · ${k}  (${n} 个文件)`);
}

console.log(`\n结论：阻断级 ${hits.length} 项，提示级 ${warns.length} 项`);
process.exitCode = hits.length ? 1 : 0;
