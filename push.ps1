# 推送到 GitHub 并启用 Pages
#
# 用法（在本目录下）：
#   pwsh -File push.ps1                          # 交互式，会提示输入 token
#   或先设置环境变量：$env:GH_TOKEN='ghp_xxx'; pwsh -File push.ps1
#
# 需要一个有 repo 权限的 GitHub Personal Access Token：
#   https://github.com/settings/tokens  ->  Generate new token (classic)  ->  勾选 repo

param(
  [string]$User = 'kiyasu-desu',
  [string]$Repo = 'sve-deckeditor',
  [string]$Token = $env:GH_TOKEN
)

$ErrorActionPreference = 'Stop'

if (-not $Token) {
  $sec = Read-Host -Prompt "请输入 GitHub Personal Access Token (repo 权限)" -AsSecureString
  $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
if (-not $Token) { Write-Error '未提供 token'; exit 1 }

$api = 'https://api.github.com'
$hdr = @{
  Authorization          = "token $Token"
  Accept                 = 'application/vnd.github+json'
  'User-Agent'           = 'sve-deckeditor-push'
}

# ---------- 1. 创建仓库（已存在则跳过） ----------
Write-Host "`n[1/4] 检查仓库 $User/$Repo ..."
try {
  $r = Invoke-RestMethod -Uri "$api/repos/$User/$Repo" -Headers $hdr -Method Get
  Write-Host "      已存在，跳过创建"
} catch {
  Write-Host "      不存在，创建公开仓库 ..."
  $body = @{
    name        = $Repo
    description = 'SVE 卡组编辑器：口袋影之诗网页版组卡工具'
    private     = $false
    has_issues  = $true
    has_wiki    = $false
  } | ConvertTo-Json
  Invoke-RestMethod -Uri "$api/user/repos" -Headers $hdr -Method Post -Body $body -ContentType 'application/json' | Out-Null
  Write-Host "      创建完成"
  Start-Sleep -Seconds 2
}

# ---------- 2. 配置 remote 并推送 ----------
Write-Host "`n[2/4] 推送代码 ..."
$remote = "https://$User`:$Token@github.com/$User/$Repo.git"
if (git remote | Select-String -Quiet '^origin$') {
  git remote set-url origin $remote
} else {
  git remote add origin $remote
}
git branch -M main
git push -u origin main --force
if ($LASTEXITCODE -ne 0) { Write-Error '推送失败'; exit 1 }
Write-Host "      推送完成"

# 推送后把 token 从 remote URL 里摘掉，避免留在本地配置
git remote set-url origin "https://github.com/$User/$Repo.git"

# ---------- 3. 启用 Pages ----------
Write-Host "`n[3/4] 启用 GitHub Pages ..."
$pagesBody = @{ source = @{ branch = 'main'; path = '/' } } | ConvertTo-Json -Depth 4
try {
  Invoke-RestMethod -Uri "$api/repos/$User/$Repo/pages" -Headers $hdr -Method Post -Body $pagesBody -ContentType 'application/json' | Out-Null
  Write-Host "      Pages 已启用"
} catch {
  # 已启用时会报 409，视为成功
  if ($_.Exception.Response.StatusCode.value__ -eq 409) { Write-Host "      Pages 已启用（跳过）" }
  else { Write-Host "      启用失败：$($_.Exception.Message)（可稍后在仓库 Settings -> Pages 手动开启）" }
}

# ---------- 4. 查看状态 ----------
Write-Host "`n[4/4] 部署状态 ..."
Start-Sleep -Seconds 3
try {
  $p = Invoke-RestMethod -Uri "$api/repos/$User/$Repo/pages" -Headers $hdr -Method Get
  Write-Host "      地址: $($p.html_url)"
  Write-Host "      状态: $($p.status)"
} catch {
  Write-Host "      暂未就绪，稍后访问 https://$User.github.io/$Repo/"
}

Write-Host "`n完成。首次部署约需 1-2 分钟。"
Write-Host "站点地址: https://$User.github.io/$Repo/"
