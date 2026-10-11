# SVE 卡组编辑器

《口袋影之诗》(Shadowverse: Evolve) 的网页版卡组编辑器。原 APP 的筛选与操作体验不佳，此项目复刻其组卡功能并做了针对性优化，导出的卡组码可直接在官方 APP 中导入使用。

## 功能

- **从首页进入组卡流程**：先选职业/主题与主战者，再进入卡池
- **官方职业图标**：从游戏资源包逆向出的 9 个职业/主题按钮
- **筛选**：关键词、费用（`1-`/`2`…`7`/`8+`）、类型、职业、稀有度、卡盒（PR 单独一盒）、兵种（含搜索）
- **组卡规则**：基础卡组 40–50 张（随从/护符/法术），进化卡组 0–10 张（进化卡）；每张卡最多 3 张
- **查看卡组**：主战者卡图 + 卡牌构成 + 费用曲线 + 平铺卡图预览
- **导出卡组码**：AES-CBC 加密，与官方 APP 完全兼容（已用真实卡组码逐字节验证）
- **导出卡组图片**：Canvas 合成 PNG 下载
- **卡组管理**：保存 / 暂存 / 我的卡组 / 删除

## 技术要点

纯静态站点，无后端依赖。

### 图片加载

游戏资源放在网易 CDN 上，但**返回的不是图片字节**，而是「路径前缀 + base64」文本：

```
152/a/a/iVBORw0KGgoAAAANSUhEUgAAAOgAAADm...
└─前缀─┘ └────── 真正的 base64 ──────┘
```

因此必须在前端剥掉前缀、base64 解码后再交给 `<img>`。实现见 `app.js` 的 `decodeGsfText()` / `cardImageUrl()`：

- 解码结果写入 **Cache API**，二次访问不再走网络
- **IntersectionObserver** 懒加载，进入视口才取图
- **并发闸门**（6 路）避免连接被打满
- CDN 连续失败时自动回退到同源 `/img/` 代理（自建服务器时可用）

> 注：CDN 上的 PNG 普遍是被截断的数据流。卡图只损失约 0.1%（肉眼不可见），
> 但职业图标损失可达 9%（底部明显被裁），因此仓库内的图标已用 PIL 重新编码为完整 PNG。

### 卡组码算法

```js
CryptoJS.AES.encrypt(
  JSON.stringify({ 1: 卡池名, 2: 主战者shortId, 3: [基础卡shortId...], 4: [进化卡shortId...] }),
  CryptoJS.enc.Utf8.parse(KEY),
  { iv: CryptoJS.enc.Utf8.parse(IV), mode: CBC, padding: Pkcs7 }
).toString()
```

卡池名与 shortId 均取自游戏内置配表，因此生成的卡组码与官方 APP 双向兼容。

## 部署到 GitHub Pages

本项目是纯静态站点，可直接用 Pages 托管，无需任何后端。

**一键脚本**（推荐）：

```powershell
# 在本目录下执行，会依次：创建仓库 -> 推送 -> 启用 Pages
pwsh -File push.ps1
```

需要一个有 `repo` 权限的 Personal Access Token（https://github.com/settings/tokens ）。
也可以先用环境变量传入：`$env:GH_TOKEN='ghp_xxx'; pwsh -File push.ps1`

**手动方式**：

```bash
git remote add origin https://github.com/<你的用户名>/sve-deckeditor.git
git branch -M main
git push -u origin main
```

然后在仓库 **Settings → Pages** 里把 Source 设为 `Deploy from a branch`，分支选 `main`、目录选 `/ (root)`。

部署后地址为 `https://<你的用户名>.github.io/sve-deckeditor/`。

> 已内置 `.nojekyll` 跳过 Jekyll 处理；所有资源引用都是相对路径，
> 已用脚本 `scripts/test_subpath.mjs` 验证过子路径部署下不会 404。

### 自建服务器

若想用自己的服务器（首屏更快，图片走本地缓存）：

```bash
node serve.mjs          # 默认 8099，可用 PORT 环境变量修改
```

`serve.mjs` 除托管静态文件外，还提供 `/img/<md5>` 代理：从 CDN 取图、解码并落盘缓存。
前端会自动检测（本机环境优先走代理，CDN 连续失败时也会回退），因此同一份代码两种部署都能用。

## 本地运行

需要一个静态服务器（直接双击 `index.html` 会因 `file://` 限制无法加载数据）：

```bash
node serve.mjs
# 打开 http://127.0.0.1:8099/
```

## 目录

```
index.html        页面结构
style.css         样式
app.js            全部逻辑（约 1600 行，无框架）
serve.mjs         本地静态服务器 + 图片代理（可选）
data/cards.json   卡表（6053 张，由官方配表解密生成）
icons/            职业/主题图标（9 张，已重新编码）
lib/crypto-js.js  卡组码加解密
scripts/          构建与校验脚本
```

## 数据来源

卡表、卡图、图标均来自《口袋影之诗》官方客户端资源包。

`data/cards.json`（6053 张）由本地工具链从客户端配表生成，该工具链**不包含在本仓库中**
（涉及官方配表的解密密钥，不适合公开分发）。仓库内只保留运行与校验所需的脚本：

```
scripts/deckcode.mjs           卡组码工具：解码 / 编码 / 往返校验
scripts/preflight.mjs          发布前总检（语法/结构/数据/图标/体积）
scripts/check_structure.mjs    检查 HTML/JS 元素引用一致性
scripts/test_subpath.mjs       验证 Pages 子路径部署不 404
scripts/scan_secrets.mjs       提交前凭据扫描
scripts/verify_icon_zlib.mjs   校验图标 PNG 数据完整性
scripts/verify_icons_full.mjs  校验图标可完整渲染
scripts/reencode_icons.py      把截断的 PNG 重新编码为完整 PNG
scripts/render_wizard_mock.py  离线渲染职业按钮预览
```

## 卡组码工具

```bash
# 解码为可读结构（含卡名）
node scripts/deckcode.mjs decode "<卡组码>"

# 编码
node scripts/deckcode.mjs encode '{"1":"赛马娘","2":881,"3":[941,941,941],"4":[]}'

# 往返校验
node scripts/deckcode.mjs selftest
```

本项目仅用于个人组卡便利，不包含任何游戏本体内容。

## 许可

仅供学习交流使用。
