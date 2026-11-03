<#
.SYNOPSIS
  点一下游戏的「点击进入」按钮（星铁/绝区零等启动后的登录界面）。

.DESCRIPTION
  2026-11-03 实测：March7thAssistant 启动游戏后会卡在「点击进入」画面，
  它自己的识别里没有这个界面（日志：「未识别出任何界面，请确保游戏画面干净」），
  于是体力计划那一段整个跳过，活跃度只拿到 200/500，要人工再点一次才跑得完。

  「点击进入」在画面底部居中，约在窗口高度的 90% 处（1924x1127 的窗口实测在 y=1526，
  正好落在那一行文字上）。用比例而不是固定偏移：全屏和窗口化都成立。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File click-game-login.ps1 -ProcessName StarRail
#>
[CmdletBinding()]
param(
    [string]$ProcessName = 'StarRail',
    [double]$RatioY = 0.9,
    [int]$OffsetY = 0,
    [int]$OffsetX = 0,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

if (-not ('GdClick' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class GdClick
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, UIntPtr extra);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr FindLargest(string procName)
    {
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        foreach (System.Diagnostics.Process p in System.Diagnostics.Process.GetProcessesByName(procName))
        {
            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (pid != (uint)p.Id || !IsWindowVisible(h)) return true;
                RECT r;
                if (GetWindowRect(h, out r))
                {
                    long area = (long)(r.Right - r.Left) * (long)(r.Bottom - r.Top);
                    if (area > bestArea) { bestArea = area; best = h; }
                }
                return true;
            }, IntPtr.Zero);
        }
        return best;
    }

    public static bool ClickAt(int x, int y)
    {
        SetCursorPos(x, y);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
        return true;
    }
}
'@
}

$h = [GdClick]::FindLargest($ProcessName)
if ($h -eq [IntPtr]::Zero) {
    if (-not $Quiet) { Write-Output "window-not-found" }
    exit 2
}
$rect = New-Object GdClick+RECT
[void][GdClick]::GetWindowRect($h, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$x = [int](($rect.Left + $rect.Right) / 2) + $OffsetX
$y = [int]($rect.Top + $height * $RatioY) + $OffsetY
[void][GdClick]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 300
[void][GdClick]::ClickAt($x, $y)
if (-not $Quiet) { Write-Output ("clicked {0},{1} (window {2},{3} {4}x{5})" -f $x, $y, $rect.Left, $rect.Top, $width, $height) }
exit 0
