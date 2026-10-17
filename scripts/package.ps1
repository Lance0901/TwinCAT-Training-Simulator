<#
    把模擬器打包成「解壓即用」的可攜資料夾與 ZIP。

    產出內容包含 node.exe 與所有 production 相依,所以學生電腦不需要先裝
    Node.js —— 只要有 TwinCAT(ADS router 是 TwinCAT 自帶的)就能跑。

    用法:
        npm run package

    產出:
        release\TwinCAT-Simulator-<版本>\      可直接執行的資料夾
        release\TwinCAT-Simulator-<版本>.zip   發給學生的壓縮檔
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# 明確指定 UTF-8 讀取:PowerShell 5.1 預設用系統 ANSI(繁中是 CP950),
# package.json 裡的中文會變亂碼,ConvertFrom-Json 直接解析失敗
$pkgJson = [System.IO.File]::ReadAllText((Join-Path $root 'package.json'), [System.Text.UTF8Encoding]::new($false))
$pkg = $pkgJson | ConvertFrom-Json
$version = $pkg.version
$name = "TwinCAT-Simulator-v$version"
$release = Join-Path $root 'release'
$stage = Join-Path $release $name
$app = Join-Path $stage 'app'

Write-Host "打包 $name" -ForegroundColor Cyan

# ---- 1. 前端必須是最新的 ----
if (-not (Test-Path 'web\dist\index.html')) {
    throw "找不到 web\dist —— 請先執行 npm run build"
}
$distAge = (Get-Item 'web\dist\index.html').LastWriteTime
$srcNewest = (Get-ChildItem 'web' -Recurse -File -Include *.js, *.css, *.html |
    Where-Object { $_.FullName -notlike '*\dist\*' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
if ($srcNewest -gt $distAge) {
    Write-Host "  前端原始碼比 dist 新,重新 build…" -ForegroundColor Yellow
    npm run build | Out-Null
}

# ---- 2. 清空 staging,並移除其他版本的產物 ----
#
# 舊版本留著很危險:檔名相近,很容易複製到別台電腦時拿錯,
# 然後對著早就修好的 bug 除錯半天(這件事真的發生過)。
if (Test-Path $release) {
    Get-ChildItem $release -Filter 'TwinCAT-Simulator-*' | Where-Object { $_.Name -ne $name -and $_.Name -ne "$name.zip" } | ForEach-Object {
        Write-Host "  移除舊產物 $($_.Name)" -ForegroundColor DarkGray
        Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $app -Force | Out-Null

# ---- 3. 帶上 Node runtime ----
$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe (Join-Path $stage 'node.exe')
$nodeVer = & node --version
Write-Host "  node.exe ($nodeVer)"

# ---- 4. 應用程式本體 ----
foreach ($dir in @('server', 'shared')) {
    Copy-Item $dir (Join-Path $app $dir) -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $app 'web') -Force | Out-Null
Copy-Item 'web\dist' (Join-Path $app 'web\dist') -Recurse
# plc\ 底下可能還放著自己的 TwinCAT 專案(.vs 索引、_Boot 編譯產物、.suo…),
# 那些不該進發佈包 —— 體積大、與學員無關,放在 OneDrive 上還會因為雲端檔案
# 下載逾時直接讓打包失敗。只收要給學員匯入的宣告與範例。
$plcOut = Join-Path $stage 'plc'
New-Item -ItemType Directory -Path $plcOut -Force | Out-Null
$plcFiles = Get-ChildItem 'plc' -File | Where-Object { $_.Extension -in '.TcGVL', '.TcPOU' }
foreach ($f in $plcFiles) { Copy-Item $f.FullName $plcOut }
Write-Host "  PLC 檔案 $($plcFiles.Count) 個"

Copy-Item 'README.md' (Join-Path $stage 'README.md')

# 執行時期只需要這三個直接相依,package.json 精簡過再放進去
@{
    name    = $pkg.name
    version = $version
    private = $true
    type    = 'module'
    scripts = @{ start = 'node server/index.js' }
} | ConvertTo-Json | Set-Content (Join-Path $app 'package.json') -Encoding UTF8

# ---- 5. production 相依(不含 vite / three 那些只在 build 時用的)----
Write-Host "  複製 production 相依…"
$srcModules = Join-Path $root 'node_modules'
$dstModules = Join-Path $app 'node_modules'
$paths = npm ls --omit=dev --all --parseable 2>$null |
    Where-Object { $_ -match [regex]::Escape('node_modules') } |
    Sort-Object -Unique

foreach ($p in $paths) {
    if (-not (Test-Path $p)) { continue }
    $rel = $p.Substring($srcModules.Length).TrimStart('\')
    if (-not $rel) { continue }
    $dst = Join-Path $dstModules $rel
    New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null
    # 套件內的測試、型別、文件對執行沒有幫助,一併排除以縮小體積
    Copy-Item $p $dst -Recurse -Force -Exclude '*.md', '*.map', '*.ts'
}
$modCount = (Get-ChildItem $dstModules -Directory -Recurse -Filter 'package.json' -ErrorAction SilentlyContinue).Count
Write-Host "  相依套件 $($paths.Count) 個"

# ---- 6. 批次檔與腳本 ----
#
# 編碼是這裡最容易踩的坑,兩種寫法都試過都不行:
#   * CP950(Big5)存 .bat —— 中文字的第二個位元組可能正好是 | > & 這些 cmd
#     特殊字元,整行會被拆開當命令執行。
#   * UTF-8 + chcp 65001 存 .bat —— cmd 是逐行按位元組讀檔的,切換 codepage
#     之後位元組位置會錯亂,照樣噴「不是內部或外部命令」。
#
# 所以 .bat 一律只用 ASCII,純粹當進入點;所有中文訊息與邏輯都放 .ps1,
# 並存成 UTF-8 BOM(PowerShell 5.1 讀無 BOM 會用系統 ANSI,中文一樣會爛)。
$utf8 = New-Object System.Text.UTF8Encoding $false
$utf8bom = New-Object System.Text.UTF8Encoding $true
$tools = Join-Path $stage 'tools'
New-Item -ItemType Directory -Path $tools -Force | Out-Null

# .bat 只有 ASCII —— 中文全部交給對應的 .ps1
$launch = @'
@echo off
title TwinCAT Training Simulator
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launch.ps1"
'@
[System.IO.File]::WriteAllText((Join-Path $stage '啟動模擬器.bat'), $launch, $utf8)

$installBat = @'
@echo off
title Install TwinCAT Training Simulator
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1"
pause
'@
[System.IO.File]::WriteAllText((Join-Path $stage '安裝.bat'), $installBat, $utf8)

$uninstallBat = @'
@echo off
title Uninstall TwinCAT Training Simulator
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\uninstall.ps1"
pause
'@
[System.IO.File]::WriteAllText((Join-Path $stage '解除安裝.bat'), $uninstallBat, $utf8)

$launchPs = @'
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$Host.UI.RawUI.WindowTitle = 'TwinCAT 訓練模擬器'

# 後端的訊息是 UTF-8,而 console 預設用系統 ANSI(繁中是 CP950),
# 不切過去的話 node 印出來的中文全是亂碼
$null = & chcp 65001
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host ''
Write-Host '  TwinCAT 訓練模擬器  v__VERSION__' -ForegroundColor Cyan
Write-Host '  ------------------------------------------------'
Write-Host '  啟動中,瀏覽器會自動開啟。'
Write-Host '  要結束模擬器,直接關掉這個視窗即可。'
Write-Host ''

$node = Join-Path $root 'node.exe'
$entry = Join-Path $root 'app\server\index.js'

# I/O 對映與上次的場景存在發佈包根目錄的 config\,不要跟著程式碼埋進 app\。
# 升級只要把這個資料夾複製到新版底下,學員綁好的變數就不用重來。
$env:SIM_CONFIG = Join-Path $root 'config'

if (-not (Test-Path $node)) { Write-Host "  找不到 $node" -ForegroundColor Red; Read-Host '  按 Enter 結束'; return }
if (-not (Test-Path $entry)) { Write-Host "  找不到 $entry" -ForegroundColor Red; Read-Host '  按 Enter 結束'; return }

# 引號不可省:解壓路徑只要有空格(桌面、下載資料夾很常見),
# Start-Process 會把它拆成多個參數,node 就會說找不到模組
$proc = Start-Process $node -ArgumentList "`"$entry`"" -WorkingDirectory $root -PassThru -NoNewWindow

# 等後端真的開始聽 3300 再開瀏覽器,不然會先看到一次連線失敗
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if ($proc.HasExited) { break }
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', 3300)
        $c.Close()
        $ready = $true
        break
    } catch { }
}

if ($ready) {
    Start-Process 'http://localhost:3300'
    Write-Host '  已開啟 http://localhost:3300' -ForegroundColor Green
    Write-Host ''
} elseif (-not $proc.HasExited) {
    Write-Host '  後端似乎沒有在 3300 啟動,請看上方訊息。' -ForegroundColor Yellow
}

Wait-Process -Id $proc.Id -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '  模擬器已停止。若上方有錯誤訊息,請截圖回報。'
Read-Host '  按 Enter 關閉視窗'
'@
$launchPs = $launchPs.Replace('__VERSION__', $version)
[System.IO.File]::WriteAllText((Join-Path $tools 'launch.ps1'), $launchPs, $utf8bom)

$installPs = @'
$ErrorActionPreference = 'Stop'
$src = Split-Path (Split-Path $PSScriptRoot -Parent) -Leaf
$srcDir = Split-Path $PSScriptRoot -Parent
$target = Join-Path $env:LOCALAPPDATA 'TwinCATSimulator'
$shortcutName = 'TwinCAT 訓練模擬器.lnk'

Write-Host ''
Write-Host '  安裝 TwinCAT 訓練模擬器' -ForegroundColor Cyan
Write-Host "  安裝位置:$target"
Write-Host '  (裝在使用者目錄,不需要系統管理員權限)'
Write-Host ''

# 已經在安裝目錄裡執行的話,再複製一次會把自己覆蓋掉
if ($srcDir -eq $target) {
    Write-Host '  這份已經是安裝好的版本了,不需要再安裝一次。' -ForegroundColor Yellow
    return
}

$stash = $null
if (Test-Path $target) {
    Write-Host '  偵測到舊版本,先移除…'

    # 升級是整個目錄砍掉重建,config\ 裡是學員自己綁的 PLC 變數對映,
    # 跟著被清掉的話每次更新都要重綁一次。先接出來,複製完再放回去。
    $oldConfig = Join-Path $target 'config'
    if (Test-Path $oldConfig) {
        $stash = Join-Path $env:TEMP ('TwinCATSimulator-config-' + [Guid]::NewGuid().ToString('N'))
        Copy-Item $oldConfig $stash -Recurse -Force
    }

    Get-Process node -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($target, [StringComparison]::OrdinalIgnoreCase) } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host '  複製檔案…'
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item (Join-Path $srcDir '*') $target -Recurse -Force

if ($stash) {
    Write-Host '  沿用先前綁定的 I/O 對映…'
    Copy-Item $stash (Join-Path $target 'config') -Recurse -Force
    Remove-Item $stash -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host '  建立捷徑…'
$shell = New-Object -ComObject WScript.Shell
$places = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)
foreach ($place in $places) {
    $lnk = $shell.CreateShortcut((Join-Path $place $shortcutName))
    $lnk.TargetPath = Join-Path $target '啟動模擬器.bat'
    $lnk.WorkingDirectory = $target
    $lnk.IconLocation = Join-Path $target 'node.exe'
    $lnk.Description = 'TwinCAT 訓練模擬器'
    $lnk.Save()
}

Write-Host '  註冊解除安裝項目…'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\TwinCATSimulator'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty $key DisplayName     'TwinCAT 訓練模擬器'
Set-ItemProperty $key DisplayVersion  '__VERSION__'
Set-ItemProperty $key Publisher       'TwinCAT Training'
Set-ItemProperty $key InstallLocation $target
Set-ItemProperty $key UninstallString ('"' + (Join-Path $target '解除安裝.bat') + '"')
Set-ItemProperty $key DisplayIcon     (Join-Path $target 'node.exe')
Set-ItemProperty $key NoModify 1
Set-ItemProperty $key NoRepair 1

Write-Host ''
Write-Host '  安裝完成。' -ForegroundColor Green
Write-Host '  桌面與開始選單都有「TwinCAT 訓練模擬器」捷徑。'
Write-Host '  要移除的話,到「設定 > 應用程式」找它,或執行安裝目錄裡的 解除安裝.bat。'
Write-Host ''
'@
$installPs = $installPs.Replace('__VERSION__', $version)
[System.IO.File]::WriteAllText((Join-Path $tools 'install.ps1'), $installPs, $utf8bom)

$uninstallPs = @'
$ErrorActionPreference = 'SilentlyContinue'
$target = Join-Path $env:LOCALAPPDATA 'TwinCATSimulator'
$shortcutName = 'TwinCAT 訓練模擬器.lnk'

Write-Host ''
Write-Host '  解除安裝 TwinCAT 訓練模擬器' -ForegroundColor Cyan
Write-Host '  (你自己的 PLC 專案與 TwinCAT 設定不受影響)'
Write-Host ''

Write-Host '  關閉執行中的模擬器…'
Get-Process node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($target, [StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force

Write-Host '  移除捷徑…'
$places = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)
foreach ($place in $places) {
    $lnk = Join-Path $place $shortcutName
    if (Test-Path $lnk) { Remove-Item $lnk -Force }
}

Write-Host '  移除登錄項目…'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\TwinCATSimulator'
if (Test-Path $key) { Remove-Item $key -Recurse -Force }

if (Test-Path (Join-Path $target 'config')) {
    Write-Host '  注意:你綁定的 I/O 對映(config 資料夾)會一起刪除。' -ForegroundColor Yellow
    Write-Host '        只是要換新版的話不必解除安裝,直接執行新版的 安裝.bat 就會沿用設定。' -ForegroundColor Yellow
}

Write-Host '  刪除程式檔案…'
if (Test-Path $target) {
    # 這個腳本自己就在要刪的資料夾裡,交給另一個行程延遲刪除。
    # 路徑一定要包引號,不然安裝在含空格的目錄時 rmdir 會刪錯東西。
    $cmd = 'timeout /t 3 /nobreak >nul & rmdir /s /q "{0}"' -f $target
    Start-Process cmd -ArgumentList '/c', $cmd -WindowStyle Hidden
}

Write-Host ''
Write-Host '  已解除安裝。' -ForegroundColor Green
Write-Host ''
'@
[System.IO.File]::WriteAllText((Join-Path $tools 'uninstall.ps1'), $uninstallPs, $utf8bom)

# ---- 7. 使用說明 ----
$readme = @"
TwinCAT 訓練模擬器 v$version
================================================================

這是什麼
----------------------------------------------------------------
用網頁模擬真實機台的物理行為,透過 ADS 與 TwinCAT PLC 雙向即時
交握。三個場景:輸送帶分料站、XY 定位滑台(NC 虛擬軸)、
液位溫度反應槽。


怎麼開始
----------------------------------------------------------------
免安裝:直接點「啟動模擬器.bat」。

想要桌面捷徑與正式的解除安裝項目:點「安裝.bat」。
會裝到使用者目錄,不需要系統管理員權限。


需要先準備什麼
----------------------------------------------------------------
* TwinCAT 3(ADS router 由它提供)
* 不需要安裝 Node.js —— 已經包在裡面了

模擬器預設連本機 TwinCAT。連線位址在網頁右上角「連線設定」
可以隨時改,不必動任何檔案。


沒有 TwinCAT 也想先看看
----------------------------------------------------------------
啟動後在「連線設定」點「切換為手動模式」,致動器開關就直接
驅動物理模型,不經過 PLC。三個場景都能完整操作。


PLC 端的檔案
----------------------------------------------------------------
plc\ 資料夾裡是建議的變數宣告(.TcGVL)與範例程式(.TcPOU),
可以在 TwinCAT 用 Add Existing Item 加進專案。

不想用也沒關係:模擬器綁的是符號路徑而不是變數名稱,
在網頁的「I/O 對映」把訊號接到你自己的變數就好。


詳細說明
----------------------------------------------------------------
見 README.md(場景說明、NC 軸設定、座標表、常見問題)。
"@
[System.IO.File]::WriteAllText((Join-Path $stage '使用說明.txt'), $readme, $utf8)

# ---- 8. 壓縮 ----
$zip = Join-Path $release "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host "  壓縮中…"
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal

$stageSize = (Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
$zipSize = (Get-Item $zip).Length / 1MB

Write-Host ''
Write-Host '完成' -ForegroundColor Green
Write-Host ("  資料夾  {0,7:N1} MB   {1}" -f $stageSize, $stage)
Write-Host ("  ZIP     {0,7:N1} MB   {1}" -f $zipSize, $zip)
