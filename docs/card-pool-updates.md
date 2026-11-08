# 卡池自动更新与验收

站点仍是纯静态页面。GitHub Actions 每 6 小时检查官方正式服资源；网页不需要登录官方账号，也不会接触配表解密参数。

## 启用条件

本 PR 审查通过并合并后，在仓库 Settings → Secrets and variables → Actions 添加 `SVE_TABLE_KEY`，值使用本地已有的配表解密参数。不要把值写进代码、PR、日志或命令行参数。未配置时更新任务会明确失败，已发布的卡池不受影响。

工作流需要 `contents: write` 提交数据、`actions: write` 请求现有 Pages 工作流。若 main 启用保护规则，应允许此更新方式，或另行改为自动数据 PR；推送被拒绝时任务停止，不强制推送。

运行时间为 UTC 每 6 小时的第 17 分钟，即日本时间约 03:17、09:17、15:17、21:17；GitHub 调度可能延迟。可随时从 Actions → Update card pool → Run workflow 手动检查，仅 main 允许写入和发布。

## 本地命令

需要 Node.js 22+，无 npm 依赖。在仓库根目录运行，并提前在当前进程环境中配置 `SVE_TABLE_KEY`：

```sh
node scripts/update-cards.mjs          # 检查并生成统计，不写文件
node scripts/update-cards.mjs --apply  # 校验成功后写入 cards.json 和 pool-version.json
node --test tests/*.test.mjs
node scripts/preflight.mjs
node scripts/test_subpath.mjs
node scripts/deckcode.mjs selftest
node scripts/scan_secrets.mjs
```

运行 `tests/regression/` 下所有 `.mjs` 可验证运行时启动、旧卡组保护、备份、移动端浮层、主题卡池和图片噪点算法。CI 与发布前工作流都会执行它们。

## 更新规则

1. 从官方 `server_list` 发现配置，精确匹配正式 API、安卓平台、版本和渠道，并排除测试配置。当前客户端版本固定为 `1.2.0`；后续版本失配时停止，需要维护者核查后调整，不能自动猜测。
2. 只访问固定官方 CDN，不跟随重定向；单个响应最多 12 MiB，20 秒超时，最多尝试 3 次。
3. 获取清单中的卡牌、shortId、卡盒配表。CSV 支持 BOM、引号、逗号和多行文本；图片映射、主题归属随卡表一起生成。
4. 旧卡号不能消失，旧 shortId 和已有主题不能改变。卡号与 shortId 必须唯一，必要字段和图片映射必须完整。新的特殊 `maxcount` 值需要人工核查。
5. 官方表中两组历史重复 ID 保持已发布映射：`PR-113SC → 2355`，`BP15-SSP08SC → 4548`。新重复冲突、已知冲突内容变化或未知主题均停止发布。
6. 检查通过才提交两个数据文件；没有变化不提交，保留原更新时间。不会自动修改 `app.js` 或版本号。
7. 自动提交使用 `GITHUB_TOKEN`，不会触发普通 push 工作流，因此显式请求 `pages.yml`。若提交后部署请求失败，Actions 摘要会提示手动运行 Sync to gh-pages。

资源名中的哈希沿用官方映射，不当作下载正文的 MD5 校验值。更新记录另保存清单 SHA-256 和生成卡表 SHA-256。网页每次启动获取最新元数据，使用数据摘要作为卡表请求的缓存标识，并在安全上下文验证卡表摘要；边缘缓存版本不一致时重试一次。旧站点缺少元数据时仍能加载卡表。

## 本次数据基线

- 正式服清单：`v1.2.0-all-202611031102-all_manifest.manifest`。
- 6341 个唯一卡号；较原版新增 BP20 266 条及 PR 22 条。
- BP20 为「灾杰的继承者」，配表发售日 `2026.11.5`。
- 全部卡牌都有 shortId 与卡图映射，6104 条有效果文本。
- 原有 6053 个卡号及其 shortId 保留；主题归属保持不变。
- BP20 按当前规则为基础卡 161、进化卡 59、主战者/衍生物等 46；统计包含不同卡面。

## 审查后部署验收

本 PR 不执行合并或线上发布。审查通过后按以下顺序完成：

1. 配置 Secret，确认分支保护和 Actions 写权限；合并 PR。
2. 确认 Checks 和 Sync to gh-pages 成功，核对发布提交确实包含本次代码及数据。
3. 在真实 Pages 子路径打开站点，检查首页显示 BP20、6341 张及更新时间，手机与桌面均无布局问题。
4. 筛选 BP20，抽查基础卡、进化卡、主战者和卡图；确认衍生物未混入可组卡池。
5. 使用已有卡组验证载入、增删、备份导入和图片导出；使用 BP20 卡组验证官方 APP 导入/导出码。
6. 手动运行 Update card pool，确认 GitHub 执行环境可访问资源、Secret 可用，以及无变化时不产生提交或重复发布。
7. 若验证失败，回退 PR 对应提交并重新发布；不要单独替换元数据或修改旧卡组的 shortId。

自动化测试不能代替真实官方 APP 的兼容性验收。发现数据异常时查看失败任务日志，旧站点继续使用上一次发布的数据。
