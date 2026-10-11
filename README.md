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

## 本地运行

需要一个静态服务器（直接双击 `index.html` 会因 `file://` 限制无法加载数据）：

```bash
node serve.mjs
# 打开 http://127.0.0.1:8099/
```

`serve.mjs` 除托管静态文件外，还提供 `/img/<md5>` 代理：从 CDN 取图、解码并落盘缓存，
本地开发时首屏更快（前端会自动检测到本机环境并优先使用它）。

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
scripts/check_structure.mjs    检查 HTML/JS 元素引用一致性
scripts/verify_encode.mjs      用真实卡组码逐字节验证加解密
scripts/decode_deckcode.mjs    把卡组码解成可读结构
scripts/verify_icon_zlib.mjs   校验图标 PNG 数据完整性
scripts/verify_icons_full.mjs  校验图标可完整渲染
scripts/scan_secrets.mjs       提交前凭据扫描
scripts/reencode_icons.py      把截断的 PNG 重新编码为完整 PNG
scripts/render_wizard_mock.py  离线渲染职业按钮预览
```

本项目仅用于个人组卡便利，不包含任何游戏本体内容。

## 许可

仅供学习交流使用。
