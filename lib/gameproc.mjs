// 游戏进程收尾：跑完一轮就把游戏关掉，下一轮开始前先确保别的游戏已退出。
//
// 目标很单纯：减少后台占用，并且避免下一个游戏被上一个游戏的窗口/进程干扰。
// 这里只 kill 自己这套插件支持的几个游戏进程（外加原神链路的 BetterGI），不碰别的程序。
//
// 为什么用 PowerShell 而不是 tasklist/taskkill：中文 Windows 上 tasklist/taskkill 的输出是
// 控制台代码页（936/GBK），Node 按 UTF-8 解码会变成乱码，没法可靠判断「进程不存在」；
// Get-Process/Stop-Process 走对象而不是文本，判断只看 Count，稳得多。
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const PS = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

const PS_PREFIX =
  "$ProgressPreference='SilentlyContinue';$OutputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;";

/** 各游戏可能出现的进程名（大小写不敏感）。 */
export const GAME_PROCESSES = {
  genshin: ['YuanShen.exe', 'GenshinImpact.exe'],
  hi: ['BH3.exe'],
  sr: ['StarRail.exe'],
  zzz: ['ZenlessZoneZero.exe'],
};

/** 原神链路额外要收的宿主进程。 */
const HOST_PROCESSES = {
  genshin: ['BetterGI.exe'],
};

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function baseName(exe) {
  return String(exe).replace(/\.exe$/i, '');
}

function runPowerShell(script, timeout = 20000) {
  return execFileSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_PREFIX + script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function parseJson(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function allProcessNames() {
  const names = new Set();
  for (const list of Object.values(GAME_PROCESSES)) for (const exe of list) names.add(baseName(exe));
  for (const list of Object.values(HOST_PROCESSES)) for (const exe of list) names.add(baseName(exe));
  return [...names];
}

/** 当前在跑的进程基名集合（小写）。 */
function runningProcessNames() {
  const names = allProcessNames();
  const script = `$names=@(${names.map(psQuote).join(',')});@(Get-Process -Name $names -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName -Unique) | ConvertTo-Json -Compress`;
  try {
    const parsed = parseJson(runPowerShell(script, 15000));
    const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return new Set(list.map((name) => String(name).toLowerCase()));
  } catch {
    return new Set();
  }
}

/** 当前哪些支持的游戏在跑：{ genshin: true/false, ... }。 */
export function runningGames() {
  const names = runningProcessNames();
  const out = {};
  for (const [gameId, processes] of Object.entries(GAME_PROCESSES)) {
    out[gameId] = processes.some((exe) => names.has(baseName(exe).toLowerCase()));
  }
  return out;
}

function killProcesses(processes) {
  const bases = processes.map(baseName);
  const script = [
    `$targets=@(${bases.map(psQuote).join(',')});`,
    '$result=@();',
    'foreach ($t in $targets) {',
    '  $p=@(Get-Process -Name $t -ErrorAction SilentlyContinue);',
    "  if ($p.Count -eq 0) { $result += [pscustomobject]@{name=$t; ok=$true; closed=$false; note='not running'}; continue }",
    '  try { $p | Stop-Process -Force -ErrorAction Stop; $result += [pscustomobject]@{name=$t; ok=$true; closed=$true; note=$null} }',
    '  catch { $result += [pscustomobject]@{name=$t; ok=$false; closed=$false; note=($_.Exception.Message)} }',
    '}',
    '$result | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');

  let rows = [];
  try {
    const parsed = parseJson(runPowerShell(script, 25000));
    rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch (error) {
    const message = String((error && error.message) || error).trim().slice(0, 200);
    return processes.map((exe) => ({ process: exe, ok: false, closed: false, note: message }));
  }

  return processes.map((exe) => {
    const base = baseName(exe).toLowerCase();
    const row = rows.find((item) => String(item && item.name).toLowerCase() === base);
    if (!row) return { process: exe, ok: false, closed: false, note: 'no result' };
    return { process: exe, ok: row.ok !== false, closed: row.closed === true, note: row.note || undefined };
  });
}

/** 关掉某个游戏的进程（含原神链路的 BetterGI）。 */
export function closeGame(gameId) {
  const processes = [...(GAME_PROCESSES[gameId] || []), ...(HOST_PROCESSES[gameId] || [])];
  if (!processes.length) return { gameId, ok: true, results: [], closed: [] };
  const results = killProcesses(processes);
  const closed = results.filter((item) => item.closed).map((item) => item.process);
  return { gameId, ok: results.every((item) => item.ok), results, closed };
}

/** 开始某个游戏之前，先把其它游戏都关掉（用户要求：进星铁/原神前确保上一个已退出）。 */
export function closeOtherGames(gameId) {
  const out = [];
  for (const otherId of Object.keys(GAME_PROCESSES)) {
    if (otherId === gameId) continue;
    const closed = closeGame(otherId);
    if (closed.closed.length) out.push({ gameId: otherId, results: closed.results });
  }
  return out;
}

/**
 * 关掉某个游戏，并**确认真的关掉了**。
 *
 * 2026-11-03 实测：日常跑完后 BetterGI 会在几十秒后自己再起一个实例、还把原神也拉起来了
 * （日志里 18:37:58 出现了一个新的 BetterGI 实例，18:38:01 原神跟着起来）——
 * 看着像「窗口修复链」把游戏重启了。
 * 只 kill 一次不够：这里 kill 完等一会儿再看，还活着就再 kill，最多三轮。
 *
 * @param {string} gameId
 * @param {{rounds?:number, waitMs?:number}} [opts]
 */
export async function closeGameAndVerify(gameId, { rounds = 3, waitMs = 3000 } = {}) {
  const attempts = [];
  for (let i = 0; i < Math.max(1, rounds); i += 1) {
    const closed = closeGame(gameId);
    attempts.push(closed);
    // 等一下再看它有没有自己复活
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const alive = runningGames() || {};
    if (alive[gameId] !== true) break;
  }
  const alive = runningGames() || {};
  return {
    gameId,
    attempts,
    stillRunning: alive[gameId] === true,
    results: attempts.length ? attempts[attempts.length - 1].results : [],
  };
}

export default { GAME_PROCESSES, runningGames, closeGame, closeOtherGames, closeGameAndVerify };
