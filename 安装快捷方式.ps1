# 悬浮AI小助手 - 安装/卸载 桌面快捷方式 + 开机自启动
# 用法:
#   powershell -ExecutionPolicy Bypass -File 安装快捷方式.ps1           # 安装
#   powershell -ExecutionPolicy Bypass -File 安装快捷方式.ps1 -Remove   # 卸载
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$electronExe = Join-Path $project 'electron\node_modules\electron\dist\electron.exe'
$appDir = Join-Path $project 'electron'
$iconFile = Join-Path $project 'icon.ico'
$shortcutName = '悬浮AI小助手.lnk'

$desktop = [Environment]::GetFolderPath('Desktop')
$startup = [Environment]::GetFolderPath('Startup')

function New-Link {
  param($Target, $ArgString, $WorkDir, $Path, $Icon)
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($Path)
  $sc.TargetPath = $Target
  $sc.Arguments = $ArgString
  $sc.WorkingDirectory = $WorkDir
  $sc.Description = '悬浮AI小助手 - 桌面悬浮窗'
  if ($Icon) { $sc.IconLocation = "$Icon,0" }
  $sc.Save()
}

# 生成一个简单的紫色圆形图标（失败就退回用 electron 自带图标）
function New-Icon {
  param($Path)
  try {
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap 64, 64
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point 64, 64),
      [System.Drawing.Color]::FromArgb(255, 129, 140, 248),
      [System.Drawing.Color]::FromArgb(255, 55, 48, 163))
    $g.FillEllipse($brush, 4, 4, 56, 56)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 255, 255, 255)), 4
    $g.DrawEllipse($pen, 12, 12, 40, 40)
    $font = New-Object System.Drawing.Font -ArgumentList @('Segoe UI', 22, [System.Drawing.FontStyle]::Bold)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString('AI', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 0, 64, 64), $sf)
    $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Icon)
    $bmp.Dispose()
    return $Path
  } catch {
    return $null
  }
}

if ($Remove) {
  Remove-Item (Join-Path $desktop $shortcutName) -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $startup $shortcutName) -Force -ErrorAction SilentlyContinue
  Write-Host '已删除：桌面快捷方式、开机自启动。'
} else {
  if (!(Test-Path $electronExe)) {
    Write-Host '[错误] Electron 还没安装，请先双击 启动悬浮助手-桌面版.bat 完成首次安装。' -ForegroundColor Red
    exit 1
  }
  $icon = New-Icon $iconFile
  $desktopLink = Join-Path $desktop $shortcutName
  $startupLink = Join-Path $startup $shortcutName
  New-Link $electronExe "`"$appDir`"" $appDir $desktopLink $icon
  New-Link $electronExe "`"$appDir`"" $appDir $startupLink $icon
  Write-Host "OK 已创建："
  Write-Host "   桌面快捷方式: $desktopLink"
  Write-Host "   开机自启动:   $startupLink"
  Write-Host '（删除方法：运行 卸载快捷方式与开机自启.bat，或直接删这两个快捷方式）'
}
