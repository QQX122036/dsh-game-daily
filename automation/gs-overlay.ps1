# 隐藏 BetterGI 的遮罩窗口（MaskWindow）。
#
# 为什么要藏：BetterGI 的遮罩窗口盖在游戏上（1920x1080 同尺寸、置顶），
# 外部合成的鼠标点击会被它吃掉 → 点了游戏没反应。藏起来之后，
# 外部点击才能落到游戏窗口上（AutoSkip 等脚本功能不受影响，仍在同一个进程里跑）。
param(
  [int]$Show = 0   # 0=隐藏 1=显示
)
$ErrorActionPreference = 'Continue'
$src = @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class MaskWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  public static List<IntPtr> Hits = new List<IntPtr>();
  public static uint TargetPid = 0;
  public static bool Cb(IntPtr h, IntPtr p) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (pid == TargetPid) {
      var tt = new StringBuilder(256); GetWindowText(h, tt, 256);
      if (tt.ToString() == "MaskWindow") Hits.Add(h);
    }
    return true;
  }
}
'@
if (-not ('MaskWin' -as [type])) { Add-Type -TypeDefinition $src }
[void][MaskWin]::SetProcessDpiAwarenessContext([IntPtr](-4))
$b = Get-Process -Name BetterGI -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $b) { Write-Output 'BETTERGI_NOT_RUNNING'; exit 0 }
[MaskWin]::TargetPid = [uint32]$b.Id
[MaskWin]::Hits.Clear()
[void][MaskWin]::EnumWindows([MaskWin+EnumWindowsProc]{ param($h, $pp) return [MaskWin]::Cb($h, $pp) }, [IntPtr]::Zero)
if (-not [MaskWin]::Hits.Count) { Write-Output 'NO_MASK_WINDOW'; exit 0 }
foreach ($h in [MaskWin]::Hits) { [void][MaskWin]::ShowWindow($h, $Show) }
Write-Output ("MASK_WINDOW_" + $(if ($Show) { 'SHOWN' } else { 'HIDDEN' }) + " count=" + [MaskWin]::Hits.Count)
