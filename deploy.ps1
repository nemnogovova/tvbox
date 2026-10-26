<#
  Деплой сервера TVBox на VPS одной командой:
      powershell -ExecutionPolicy Bypass -File .\deploy.ps1

  Скрипт загружает готовый бандл (deploy\tvbox-server.tgz) по SSH и запускает
  на сервере deploy/server-setup.sh (Docker, Caddy с HTTPS, coturn, .env).
  Пароль root спросит ssh — один раз за запуск. Если у вас есть SSH-ключ
  (~/.ssh/id_ed25519.pub или id_rsa.pub), он будет добавлен на сервер,
  и следующие деплои пройдут без пароля.

  -Rebuild  — пересобрать бандл из исходников (нужен Node.js 20+).
#>
param(
  [string]$Server = "109.107.185.185",
  [string]$User = "root",
  [switch]$Rebuild
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$bundle = Join-Path $PSScriptRoot "deploy\tvbox-server.tgz"

if ($Rebuild -or -not (Test-Path $bundle)) {
  Write-Host "==> Сборка бандла" -ForegroundColor Cyan
  npm install --no-audit --no-fund; if ($LASTEXITCODE) { throw "npm install failed" }
  npm run build:shared; if ($LASTEXITCODE) { throw "build failed" }
  npm run build:backend; if ($LASTEXITCODE) { throw "build failed" }
  npm run build:remote; if ($LASTEXITCODE) { throw "build failed" }
  node scripts/make-bundle.mjs; if ($LASTEXITCODE) { throw "bundle failed" }
}

$pubKey = ""
foreach ($k in @("$env:USERPROFILE\.ssh\id_ed25519.pub", "$env:USERPROFILE\.ssh\id_rsa.pub")) {
  if (Test-Path $k) { $pubKey = (Get-Content $k -Raw).Trim(); break }
}
$addKey = ""
if ($pubKey) {
  $addKey = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qF '$pubKey' ~/.ssh/authorized_keys || echo '$pubKey' >> ~/.ssh/authorized_keys) && "
}
$remote = "$addKey mkdir -p /opt/tvbox && rm -rf /opt/tvbox/server && tar -xzf - -C /opt/tvbox && bash /opt/tvbox/server-setup.sh"

Write-Host "==> Загрузка на $User@$Server и запуск (введите пароль, если ssh попросит)" -ForegroundColor Cyan
# cmd redirection is binary-safe (PowerShell 5 pipes would corrupt the archive)
$log = Join-Path $env:TEMP "tvbox-deploy.log"
cmd /c "ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 $User@$Server `"$remote`" < `"$bundle`"" | Tee-Object -FilePath $log
$code = $LASTEXITCODE
if ($code) { throw "Деплой завершился с ошибкой ($code)" }

# Token for publishing app builds (build-windows.cmd uploads installers with it)
$m = Select-String -Path $log -Pattern '@@RELEASE_TOKEN=([0-9a-f]+)@@' | Select-Object -Last 1
if ($m) {
  $token = $m.Matches[0].Groups[1].Value
  Set-Content -Path (Join-Path $PSScriptRoot ".release-token") -Value $token -NoNewline -Encoding ascii
  Write-Host "Токен публикации сборок сохранён в .release-token" -ForegroundColor DarkGray
}
Write-Host "`nГотово: https://tv.nemnogovova.com" -ForegroundColor Green
