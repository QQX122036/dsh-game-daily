# 绝区零/原神通用「一步驱动」：把「聚焦游戏窗口 → 发按键/点击 → 截图」压成一次调用。
#
# 用法：
#   powershell -File automation/gs-step.ps1 -Keys 'j','f' -Wait 1.5 -Shot C:\tmp\step.png
#   powershell -File automation/gs-step.ps1 -Click 1234,567 -Wait 2 -Shot C:\tmp\step.png
#
# 参数：
#   -Proc     进程名（默认 YuanShen）
#   -Keys     要依次发送的按键（SendKeys 语法：j / {ESC} / {F} / {SPACE}）
#   -Click    "x,y" 屏幕坐标（真实鼠标点击，会抢焦点）
#   -Wait     动作后等待秒数（默认 1.5）
#   -Shot     截图保存路径（可空）
#   -Region   截图区域 "x,y,w,h"（默认整个游戏窗口）
param(
  [string]$Proc = 'YuanShen',
  [string[]]$Keys = @(),
  [string]$Click = '',
  [double]$Wait = 1.5,
  [string]$Shot = '',
  [string]$Region = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# 必须是 DPI 感知进程：否则 GetWindowRect 返回的是虚拟化(除以1.5)的坐标，
# CopyFromScreen 也会按逻辑坐标去截物理屏幕 → 截到的是别的区域。
$src = @'
using System;
using System.Runtime.InteropServices;
public class Win32Step {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
if (-not ('Win32Step' -as [type])) { Add-Type -TypeDefinition $src }
try { [void][Win32Step]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { [void][Win32Step]::SetProcessDPIAware() }

$p = Get-Process -Name $Proc -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'GAME_NOT_RUNNING'; exit 2 }

# 聚焦游戏窗口（只有最小化时才恢复，否则会把最大化窗口还原掉、位置乱跳）
if ([Win32Step]::IsIconic($p.MainWindowHandle)) { [void][Win32Step]::ShowWindow($p.MainWindowHandle, 9) }
[void][Win32Step]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Milliseconds 600

foreach ($k in $Keys) {
  [System.Windows.Forms.SendKeys]::SendWait($k)
  Start-Sleep -Milliseconds 350
}

if ($Click) {
  $xy = $Click -split ','
  $x = [int]$xy[0]; $y = [int]$xy[1]
  [void][Win32Step]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 250
  [Win32Step]::mouse_event(0x0002, 0, 0, 0, 0)   # LEFTDOWN
  Start-Sleep -Milliseconds 60
  [Win32Step]::mouse_event(0x0004, 0, 0, 0, 0)   # LEFTUP
}

Start-Sleep -Seconds $Wait

if ($Shot) {
  $rect = [System.Drawing.Rectangle]::new(0, 0, 0, 0)
  if ($Region) {
    $r = $Region -split ','
    $rect = [System.Drawing.Rectangle]::new([int]$r[0], [int]$r[1], [int]$r[2], [int]$r[3])
  } else {
    $wr = New-Object 'Win32Step+RECT'
    [void][Win32Step]::GetWindowRect($p.MainWindowHandle, [ref]$wr)
    $rect = [System.Drawing.Rectangle]::new($wr.Left, $wr.Top, $wr.Right - $wr.Left, $wr.Bottom - $wr.Top)
  }
  $bmp = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $dir = Split-Path -Parent $Shot
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("SHOT " + $Shot + " " + $rect.Width + 'x' + $rect.Height)
} else {
  Write-Output 'OK'
}


