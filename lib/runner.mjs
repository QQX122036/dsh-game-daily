// 起一轮 headless 运行（计划任务与「立即运行一次」共用同一条路）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDsh } from './deps.mjs';
import { businessDay, businessDayOfRunId, DEFAULT_RESET_HOUR } from './dailycycle.mjs';
import { mergeReport, dailyDecision, dailySummary, readDaily } from './daily-state.mjs';
import { resolveM7a, resolveM7aTasks, m7aReport, ensurePowerPlan } from './m7a.mjs';
import { resolveBettergi, bettergiConfigName } from './bettergi.mjs';
import { ensureCommissionFlows, loadCommissionTypes } from './bettergi-commission.mjs';
import { resolveNodeExe } from './nodeexe.mjs';
import { gameById } from './games.mjs';
import { buildRunPrompt } from './prompt.mjs';
import { resolveBettergiMcp } from './bettergi-mcp.mjs';
import { ensureZzzServer, stopZzzServer, zzzCloseGame, zzzRoot, zzzBaseUrl } from './zzz.mjs';
import { closeGame, closeGameAndVerify, closeOtherGames, runningGames, GAME_PROCESSES } from './gameproc.mjs';
import {
  newRunId,
  runDirOf,
  gameRunsDir,
  metaPathOf,
  reportPathOf,
  stdoutPathOf,
  readReport,
  readJsonSafe,
  writeJson,
} from './report.mjs';

/**
 * 今天该游戏是否已经跑过（返回最近一次带报告的运行）。
 * 排班触发时用它做幂等：今天跑过就不重复拉起游戏（重复跑会白刷体力、白等一次登录）。
 *
 * 判断基准是**业务日**而不是运行日期：米哈游日常凌晨 4 点重置，
 * 0:28 补跑的那一轮做的仍然是昨天的日常，不能算作「今天做过了」。
 * 另外「幂等跳过」生成的假报告也不算数——它没真的跑游戏。
 */
export function todayRunStatus(stateDir, gameId, date = new Date(), { resetHour = DEFAULT_RESET_HOUR } = {}) {
  const todayKey = businessDay(date, resetHour);
  let names = [];
  try {
    names = fs
      .readdirSync(gameRunsDir(stateDir, gameId), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    if (businessDayOfRunId(name, resetHour) !== todayKey) continue;
    const report = readReport(stateDir, gameId, name);
    if (!report) continue;
    if (report.generatedBy === 'runner-idempotent-skip') continue; // 跳过记录不算「做过」
    if (report.status === 'success' || report.status === 'partial') {
      return { runId: name, status: report.status, finishedAt: report.endedAt || '', businessDay: todayKey };
    }
  }
  return null;
}

export function overlayPath(stateDir) {
  return path.join(stateDir, 'automation', 'headless-overlay.yml');
}

/** 同步等待（计划任务串行等待上一轮时用；不要放在 HTTP 请求路径上）。 */
function sleepSync(ms) {
  const wait = Math.max(0, Number(ms) || 0);
  if (!wait) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  } catch {
    /* ignore */
  }
}

/** 插件根目录（判断 automation/ 里随包脚本的位置，兼容 link 安装）。 */
function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * BetterGI 配置组目录里带「委托」的组名。
 *
 * 用来兜底 state.json 里的 oneDragonGroups 被覆盖成空的情况：
 * 委托做不完 → 冒险之证拿不到 → 每日奖励（90 原石）领不到。
 */
function detectCommissionGroups(bettergiRoot) {
  if (!bettergiRoot) return [];
  try {
    const dir = path.join(bettergiRoot, 'User', 'ScriptGroup');
    const names = fs
      .readdirSync(dir)
      .filter((file) => file.toLowerCase().endsWith('.json'))
      .map((file) => file.replace(/\.json$/i, ''));
    return names.filter((name) => name.includes('委托'));
  } catch {
    return [];
  }
}

/**
 * 把 M7A 的多个任务写成一份临时 .cmd，按顺序执行。
 * 走批处理而不是 cmd /c 拼字符串：cmd 的引号规则会吃掉带空格的路径。
 */
function m7aBatchFile(m7a, tasks) {
  const file = path.join(os.tmpdir(), `gd-m7a-${process.pid}-${Date.now()}.cmd`);
  const body = tasks.map((task) => `"${m7a.exe}" ${task}`).join('\r\n');
  fs.writeFileSync(file, `@echo off\r\n${body}\r\n`, 'utf8');
  return file;
}

/** 临时 .cmd 用完就删，别在 %TEMP% 里越积越多。 */
function removeTempFile(file) {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 排队文件：谁在等锁、排第几。
 *
 * 2026-11-03 实测：机器下午才开机，三条计划任务在 17:36 **同时**被拉起，
 * 谁先抢到全局锁谁先跑 —— 顺序纯看运气（那次是星铁先跑，原神排第二）。
 * 用户要的是「原神最后」（它最慢、也最需要有人盯着）。
 *
 * 做法：等锁的进程先在 stateDir 里登记排队号（按各游戏的排班时间排序），
 * 拿到锁之前再看一眼：有没有**排号更靠前**的还在等？有就让它先跑。
 */
function queuePath(stateDir, gameId) {
  return path.join(stateDir, 'automation', 'queue', `${gameId}.json`);
}

/** 排号越小越靠前（按排班时间升序；时间相同按游戏 id 稳定排序）。 */
export function runOrder(stateDir) {
  const state = readJsonSafe(path.join(stateDir, 'state.json')) || {};
  const games = state.games || {};
  return Object.keys(GAME_PROCESSES)
    .filter((id) => games[id] && games[id].enabled === true)
    .map((id) => ({
      id,
      time: String((games[id].schedule && games[id].schedule.time) || '09:00'),
    }))
    .sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id))
    .map((item, index) => ({ ...item, index }));
}

function registerQueue(stateDir, gameId, index) {
  try {
    fs.mkdirSync(path.dirname(queuePath(stateDir, gameId)), { recursive: true });
    fs.writeFileSync(
      queuePath(stateDir, gameId),
      `${JSON.stringify({ gameId, index, pid: process.pid, at: new Date().toISOString() })}\n`,
      'utf8',
    );
  } catch {
    /* ignore */
  }
}

function unregisterQueue(stateDir, gameId) {
  try {
    fs.rmSync(queuePath(stateDir, gameId), { force: true });
  } catch {
    /* ignore */
  }
}

/** 还有没有排号更靠前、且进程还活着的在等。 */
function earlierWaiters(stateDir, myIndex) {
  const dir = path.join(stateDir, 'automation', 'queue');
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    const row = readJsonSafe(path.join(dir, name));
    if (!row || typeof row.index !== 'number') continue;
    if (row.index >= myIndex) continue;
    if (row.pid && !alive(row.pid)) continue; // 那个进程没了，队列项作废
    out.push(row);
  }
  return out;
}

export function guardScriptPath() {
  return path.join(pluginRoot(), 'automation', 'keep-foreground.ps1');
}

/**
 * 子进程输出的解码（按行）。
 *
 * 实测踩过的坑：BetterGI / M7A 的控制台输出**大部分是 UTF-8**，但偶尔混进
 * 非法 UTF-8 的字节（比如控制台控制序列被截断）。之前「一律按 UTF-8」会在个别
 * chunk 上乱码；「一律按 GBK」（2026-11-04 那版）更糟 —— 整个日志和报告里的中文全糊了。
 * 所以：**按行来**，每行先严格按 UTF-8 解，遇到非法字节再退到 GBK。
 */
export function decodeChildOutput(chunk) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

/** 流式、按行解码（跨 chunk 的半行会缓冲到下一块）。 */
export function makeChildDecoder() {
  let pending = Buffer.alloc(0);
  const decodeLine = (buf) => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      try {
        return new TextDecoder('gbk').decode(buf);
      } catch {
        return buf.toString('utf8');
      }
    }
  };
  return (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    pending = pending.length ? Buffer.concat([pending, buf]) : buf;
    const out = [];
    let start = 0;
    for (let i = 0; i < pending.length; i += 1) {
      if (pending[i] !== 0x0a) continue;
      out.push(decodeLine(pending.subarray(start, i)));
      start = i + 1;
    }
    pending = start ? pending.subarray(start) : pending;
    return out.length ? `${out.join('\n')}\n` : '';
  };
}

/**
 * M7A 卡在「点击进入」登录界面时替它点一下。
 *
 * 2026-11-03 实测：M7A 自己拉起星铁后会停在「点击进入」画面，
 * 它的界面识别里没有这一屏（日志：「未识别出任何界面，请确保游戏画面干净」），
 * 于是体力计划整段被跳过 —— 活跃度只有 200/500，人工点一下之后重跑才补齐。
 * 这里看到该关键字就点游戏窗口底部中央的「点击进入」。
 */
function watchM7aLoginScreen(text, game) {
  if (!text) return;
  if (!/点击进入|未识别出任何界面/.test(text)) return;
  const stateDir = watchM7aLoginScreen.stateDir;
  if (!stateDir) return;
  const now = Date.now();
  // 30 秒内不重复点（避免连点把界面点乱）
  if (now - (watchM7aLoginScreen.last || 0) < 30000) return;
  watchM7aLoginScreen.last = now;
  const script = path.join(pluginRoot(), 'automation', 'click-game-login.ps1');
  const proc = (game.process || [])[0] || 'StarRail';
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProcessName', proc.replace(/\.exe$/i, '')],
      { windowsHide: true, timeout: 20000, encoding: 'utf8' },
    );
    appendLog(
      path.join(stateDir, 'automation', 'm7a-login.log'),
      `# ${new Date().toISOString()} ${game.id}: ${String(out || '').trim()}\n`,
    );
  } catch (error) {
    appendLog(
      path.join(stateDir, 'automation', 'm7a-login.log'),
      `# ${new Date().toISOString()} ${game.id}: 点击失败 ${String((error && error.message) || error)}\n`,
    );
  }
}

/**
 * 确保 .ps1 带 UTF-8 BOM。
 *
 * Windows PowerShell 5.1 读取**没有 BOM** 的脚本时按系统 ANSI 代码页解码
 * （本机是 GBK/936），脚本里的中文会变成乱码，轻则日志乱码、重则直接语法错误
 * —— 脚本根本跑不起来（2026-11-02 实测：前台守护因为这个直接解析失败）。
 * 仓库里的脚本被某些编辑器改写很容易掉 BOM，所以每次用之前先检查一次。
 */
export function ensureScriptBom(file) {
  try {
    const head = Buffer.alloc(3);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, head, 0, 3, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return true;
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
    return true;
  } catch {
    return false;
  }
}

// 每个游戏同时最多一个守护进程；key=gameId
const guards = new Map();

/** 运行期间盯前台：游戏被别的窗口抢走就 1 秒内拉回。守护脚本随包分发。 */
export function startForegroundGuard({ stateDir, game, maxMinutes = 150, intervalMs = 1000 }) {
  const script = guardScriptPath();
  if (!fs.existsSync(script)) return { ok: false, error: `前台守护脚本缺失：${script}` };
  ensureScriptBom(script);
  const processName = game.guardProcess || String(game.process[0] || '').replace(/\.exe$/i, '');
  if (!processName) return { ok: false, error: '无法确定游戏进程名' };
  const stopFile = path.join(stateDir, 'automation', `guard-${game.id}.stop`);
  const logFile = path.join(stateDir, 'automation', `guard-${game.id}.log`);
  try {
    fs.rmSync(stopFile, { force: true });
    fs.mkdirSync(path.dirname(stopFile), { recursive: true });
  } catch {
    /* ignore */
  }
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-GameProcessName',
    processName,
    '-IntervalMs',
    String(Math.max(500, Number(intervalMs) || 1000)),
    '-MaxMinutes',
    String(Math.max(5, Number(maxMinutes) || 150)),
    '-StopFile',
    stopFile,
    '-LogPath',
    logFile,
    '-Quiet',
  ];
  try {
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' });
    guards.set(game.id, { child, stopFile, logFile, pid: child.pid, startedAt: new Date().toISOString() });
    child.on('exit', () => {
      const current = guards.get(game.id);
      if (current && current.child === child) guards.delete(game.id);
    });
    return { ok: true, pid: child.pid, logFile, stopFile };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

export function stopForegroundGuard(stateDir, gameId) {
  const entry = guards.get(gameId);
  if (!entry) return { ok: true, stopped: false };
  try {
    fs.writeFileSync(entry.stopFile, 'stop\n', 'utf8');
  } catch {
    /* ignore */
  }
  try {
    entry.child.kill();
  } catch {
    /* ignore */
  }
  guards.delete(gameId);
  return { ok: true, stopped: true, pid: entry.pid };
}

export function guardStatus(gameId) {
  const entry = guards.get(gameId);
  if (!entry) return { running: false };
  return { running: alive(entry.pid), pid: entry.pid, logFile: entry.logFile };
}

function pidPath(stateDir, gameId) {
  return path.join(stateDir, 'automation', `runner-${gameId}.pid`);
}

/**
 * 全局互斥锁：同一时刻只允许一个游戏在跑。
 *
 * 为什么需要：计划任务「错过触发后补跑」时，三条任务会在同一秒一起被拉起，
 * 原神/星铁/绝区零同时抢前台与同一块屏幕（BetterGI 与 M7A 互相切窗口），
 * 识别率骤降、还会互相把对方的游戏进程关掉。
 *
 * 锁文件里记着持有者的 pid；进程死了就算过期锁，会被自动清掉。
 *
 * 注意：等待必须是**异步**的。早先用 Atomics.wait 同步等，会把整个 DSH 宿主
 * （Electron 主线程 + HTTP 服务）卡住最长 20 分钟，界面直接冻住。
 */
export async function acquireRunLock(stateDir, { waitMs = 20 * 60 * 1000 } = {}) {
  const lock = path.join(stateDir, 'automation', 'runner.lock');
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      } finally {
        fs.closeSync(fd);
      }
      return {
        ok: true,
        lock,
        release() {
          try {
            fs.rmSync(lock, { force: true });
          } catch {
            /* ignore */
          }
        },
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        return { ok: false, error: String((error && error.message) || error) };
      }
      // 过期锁：持有者进程已经不在了 → 直接接管
      let stale = false;
      try {
        const holder = readJsonSafe(lock) || {};
        stale = !holder.pid || !alive(holder.pid);
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          fs.rmSync(lock, { force: true });
        } catch {
          /* ignore */
        }
        continue;
      }
      if (Date.now() >= deadline) {
        return { ok: false, error: '等待其它游戏日常结束超时（超过等待上限）' };
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

/** 按游戏引擎生成 overlay：只有原神需要把 bettergi MCP 注入 headless。 */
export function ensureOverlay({ stateDir, game }) {
  const file = overlayPath(stateDir);
  const mcpScript = resolveBettergiMcp({ stateDir });
  const lines = ['# 由 dsh-game-daily 自动生成（每次运行前重写，勿手改）'];
  let hasMcp = false;
  if (game && game.engine === 'bettergi' && mcpScript) {
    hasMcp = true;
    const nodeCmd = process.versions.electron ? 'node' : process.execPath;
    const mcpCwd = path.dirname(mcpScript);
    lines.push(
      '- insert:',
      '    - id: mcp-game-daily-bettergi',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: bettergi',
      '        transport: stdio',
      `        command: '${nodeCmd.replace(/\\/g, '/')}'`,
      '        args:',
      `          - '${mcpScript}'`,
      `        cwd: '${mcpCwd.replace(/\\/g, '/')}'`,
      '        failOnStartupError: false',
    );
  } else if (game && game.engine === 'zzz-direct') {
    // 绝区零：注入插件自带的 zzz-od-mcp（stdin/stdout 直连一条龙后端）。
    const zzzScript = path.join(pluginRoot(), 'tools', 'zzz-od-mcp', 'zzz-od-mcp.mjs');
    if (!fs.existsSync(zzzScript)) return { ok: false, error: `zzz-od MCP 脚本缺失：${zzzScript}` };
    hasMcp = true;
    const nodeCmd = process.versions.electron ? 'node' : process.execPath;
    lines.push(
      '- insert:',
      '    - id: mcp-game-daily-zzz',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: zzz-od',
      '        transport: stdio',
      `        command: '${nodeCmd.replace(/\\/g, '/')}'`,
      '        args:',
      `          - '${zzzScript.replace(/\\/g, '/')}'`,
      `        cwd: '${path.dirname(zzzScript).replace(/\\/g, '/')}'`,
      '        env:',
      `          ZZZ_OD_ROOT: '${zzzRoot().replace(/\\/g, '/')}'`,
      `          ZZZ_OD_URL: '${zzzBaseUrl()}'`,
      '        failOnStartupError: false',
    );
  } else {
    // dsh 要求 overlay 顶层是 YAML 数组：没有要注入的条目时必须显式写 `[]`，
    // 否则「只有一行注释」会被判为非法 patch 并直接启动失败。
    lines.push('[]');
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  return { ok: true, file, hasMcp };
}

/** 探活时抛出的错误是否代表「进程还活着」：Windows 跨完整性级别只会给 EPERM。 */
export function aliveFromError(error) {
  return Boolean(error && error.code === 'EPERM');
}

function alive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    // 早先这里一律当成「进程不存在」，于是提权的计划任务轮次会被 reconcile 误判 failed。
    return aliveFromError(error);
  }
}

export function readRunner(stateDir, gameId) {
  const info = readJsonSafe(pidPath(stateDir, gameId));
  if (!info) return null;
  return { ...info, running: alive(info.pid) };
}

export function isRunning(stateDir, gameId) {
  const info = readRunner(stateDir, gameId);
  return Boolean(info && info.running);
}

function appendLog(file, text) {
  try {
    fs.appendFileSync(file, text, 'utf8');
  } catch {
    /* 日志写不进去不能杀宿主 */
  }
}

function fallbackReport({ gameId, mode, runId, exitCode, logTail }) {
  return {
    schemaVersion: 1,
    status: exitCode === 0 ? 'unknown' : 'failed',
    mode,
    runId,
    game: gameId,
    startedAt: '',
    endedAt: new Date().toISOString(),
    steps: [],
    evidence: [`exitCode=${exitCode}`],
    notes: exitCode === 0 ? 'headless 正常退出但没有写报告，状态未知' : `headless 退出码 ${exitCode}，未写报告`,
    stdoutTail: logTail,
    generatedBy: 'runner-fallback',
  };
}

/**
 * 写这一轮的报告（同步）。
 *
 * 单独拎出来是因为「进程退出」这件事有时序要求：
 * 看门狗每 5 秒看一次「子进程还在不在」，一看到退出就去读 report.json。
 * 报告必须先落地，否则会被判成「没有报告」（2026-11-04 实测踩过）。
 */
function writeRunReport({ stateDir, gameId, runId, mode, exitCode, startedAt, logFile, reportPath, game, isM7a }) {
  if (!fs.existsSync(reportPath)) {
    let text = '';
    try {
      text = fs.readFileSync(logFile, 'utf8');
    } catch {
      text = '';
    }
    // 直连引擎的执行脚本会打印一行 "##REPORT {json}"：那是它自己解析好的报告，优先采用。
    const inline = text
      .split('\n')
      .reverse()
      .map((line) => line.trim())
      .find((line) => line.startsWith('##REPORT '));
    if (inline) {
      try {
        const parsed = JSON.parse(inline.slice('##REPORT '.length));
        if (parsed && typeof parsed === 'object') writeJson(reportPath, parsed);
      } catch {
        /* ignore */
      }
    }
  }
  if (!fs.existsSync(reportPath)) {
    let text = '';
    try {
      text = fs.readFileSync(logFile, 'utf8');
    } catch {
      text = '';
    }
    try {
      writeJson(
        reportPath,
        isM7a
          ? m7aReport({
              gameId,
              mode,
              runId,
              exitCode,
              startedAt,
              logText: text,
              resetHour: game.dailyResetHour,
            })
          : fallbackReport({ gameId, mode, runId, exitCode, logTail: text.split('\n').slice(-40).join('\n') }),
      );
    } catch {
      /* ignore */
    }
  }
  // 每日检查点：把这轮「做完了什么 / 还差什么」记进当天，之后排班与面板都读它。
  try {
    const finalReport = readReport(stateDir, gameId, runId);
    if (finalReport) {
      mergeReport(stateDir, gameId, finalReport, { runId }, { resetHour: game.dailyResetHour });
    }
  } catch {
    /* ignore */
  }
}

/**
 * 起一轮运行。立即返回 {runId, pid, runDir}；进程结束后的收尾（meta/兜底报告）在后台完成。
 */
export async function startRun({
  gameId,
  mode = 'real',
  stateDir,
  profile = 'headless',
  trigger = 'manual',
  skillsRoot,
  timeoutMin = 90,
  guard = true,
}) {
  const game = gameById(gameId);
  if (!game) return { ok: false, error: `未知游戏：${gameId}` };
  if (!game.canRun) return { ok: false, error: `${game.title} 目前不支持自动代理` };
  if (isRunning(stateDir, gameId)) {
    const current = readRunner(stateDir, gameId);
    return { ok: false, error: `${game.title} 已有一轮在跑（pid ${current.pid}，runId ${current.runId}）` };
  }
  // 全局互斥：同一时刻只跑一个游戏。补跑时三条计划任务可能同一秒被拉起，
  // 三个游戏抢前台会互相干扰（还会互相关进程）。
  //
  // 顺序：先登记排队号（按排班时间），再等锁 —— 排号靠前的先跑，
  // 这样「机器下午才开机、三条任务同时触发」时顺序也是确定的（原神排最后）。
  let runLock = null;
  let myIndex = 0;
  if (mode === 'real') {
    const order = runOrder(stateDir);
    myIndex = (order.find((item) => item.id === gameId) || { index: order.length }).index;
    registerQueue(stateDir, gameId, myIndex);
    const waitMs = Math.max(0, Number(process.env.DSH_GAME_DAILY_WAIT_MS) || 20 * 60 * 1000);
    const queueDeadline = Date.now() + waitMs;
    while (Date.now() < queueDeadline) {
      const ahead = earlierWaiters(stateDir, myIndex);
      if (!ahead.length) break;
      appendLog(
        path.join(stateDir, 'automation', 'wait.log'),
        `# ${new Date().toISOString()} ${gameId}: 排队等 ${ahead.map((r) => r.gameId).join('、')}（排号更靠前）\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    runLock = await acquireRunLock(stateDir, { waitMs });
    if (!runLock.ok) {
      unregisterQueue(stateDir, gameId);
      return { ok: false, error: runLock.error };
    }
  }
  const releaseLock = () => {
    if (runLock && runLock.release) {
      runLock.release();
      runLock = null;
    }
  };
  // 排队项在拿到锁之后就没用了（后面等的是锁，不是顺序）。
  if (mode === 'real') unregisterQueue(stateDir, gameId);
  // 上一款游戏还在跑时不要抢：计划任务会等它收尾（最长 20 分钟），手动运行直接报错。
  if (mode === 'real') {
    const busyNow = () =>
      Object.keys(GAME_PROCESSES).filter((otherId) => otherId !== gameId && isRunning(stateDir, otherId));
    let busy = busyNow();
    if (busy.length) {
      if (trigger !== 'schedule') {
        const titles = busy.map((id) => (gameById(id) || { title: id }).title).join('、');
        // 拿了锁就一定要还，否则锁文件里的 pid 一直活着，
        // 之后每一轮 startRun 都会卡在等锁上（直到 DSH 重启）。
        releaseLock();
        return { ok: false, error: `${titles} 的日常还在跑，等它结束再试` };
      }
      const waitMs = Math.max(0, Number(process.env.DSH_GAME_DAILY_WAIT_MS) || 20 * 60 * 1000);
      const deadline = Date.now() + waitMs;
      appendLog(
        path.join(stateDir, 'automation', 'wait.log'),
        `# ${new Date().toISOString()} ${gameId}: waiting for ${busy.join(',')} to finish (max ${Math.round(waitMs / 1000)}s)\n`,
      );
      while (busyNow().length && Date.now() < deadline) sleepSync(15000);
      busy = busyNow();
      if (busy.length) {
        const titles = busy.map((id) => (gameById(id) || { title: id }).title).join('、');
        releaseLock();
        return { ok: false, error: `${titles} 的日常超过等待上限还没结束，跳过本轮` };
      }
    }
  }
  // 拿到锁之后**再查一次**幂等：
  // 等锁的这段时间里别的游戏/别的任务可能已经把今天的活干完了
  // （2026-11-03 实测：补跑时绝区零已经跑过一轮，却又开了一次游戏）。
  // 强制模式（DSH_GAME_DAILY_FORCE）只在「今天还有缺口」时才有意义：
  // 已经做完了就别再开一次游戏了。
  if (trigger === 'schedule' && mode === 'real') {
    const again = dailyDecision(stateDir, gameId, {
      resetHour: game.dailyResetHour,
      autoRetry: game.autoRetry,
    });
    const forced = /^(1|true|yes|on)$/i.test(String(process.env.DSH_GAME_DAILY_FORCE || ''));
    const entry = readDaily(stateDir, gameId, '', game.dailyResetHour);
    const alreadyDone = entry.status === 'success' && Object.keys(entry.gaps || {}).length === 0;
    if (again.skip && (!forced || alreadyDone)) {
      appendLog(
        path.join(stateDir, 'automation', 'run-headless.log'),
        `# ${new Date().toISOString()} ${gameId}: 拿到锁后复查 —— ${again.reason}，本轮不再跑\n`,
      );
      releaseLock();
      return { ok: true, skipped: true, reason: again.reason, runId: '', runDir: '' };
    }
  }

  // 三种直连引擎：bettergi（BetterGI 一条龙 CLI）、m7a（March7thAssistant CLI）、
  // zzz-direct（一条龙后端 HTTP）；其余（skill）仍走 headless + 技能。
  // 直连的好处：专业工具自己干，插件只负责起进程、收日志、写报告——没有 agent 参与的抖动。
  const engine = game.engine;
  const isM7a = engine === 'm7a';
  const isBettergi = engine === 'bettergi';
  const isZzzDirect = engine === 'zzz-direct';
  const isDirect = isM7a || isBettergi || isZzzDirect;
  let dsh = null;
  let m7a = null;
  let m7aTasks = [];
  let powerPlanInfo = null;
  let bettergi = null;
  if (isM7a) {
    const pluginState = readJsonSafe(path.join(stateDir, 'state.json')) || {};
    const configuredM7a =
      (pluginState.games && pluginState.games[gameId] && pluginState.games[gameId].m7aPath) || '';
    m7a = resolveM7a({ configured: configuredM7a });
    if (!m7a) {
      releaseLock();
      return {
        ok: false,
        error: '找不到 March7th Assistant.exe（可用 DSH_GAME_DAILY_M7A 指到程序或目录）',
      };
    }
    m7aTasks = resolveM7aTasks(game);
    // M7A 跑完会把已完成的体力计划从 config.yaml 里删掉，第二次跑就没计划了。
    // 跑之前先把计划补回去（同时把 power_plan_keep 打开，让它保留计划）。
    if (mode === 'real') {
      const plan = ensurePowerPlan(m7a);
      powerPlanInfo = plan;
      appendLog(
        path.join(stateDir, 'automation', 'm7a-plan.log'),
        `# ${new Date().toISOString()} ${gameId}: ${JSON.stringify(plan)}\n`,
      );
    }
  } else if (isBettergi) {
    const pluginState = readJsonSafe(path.join(stateDir, 'state.json')) || {};
    const configuredBettergi =
      (pluginState.games && pluginState.games[gameId] && pluginState.games[gameId].bettergiPath) || '';
    bettergi = resolveBettergi({ configured: configuredBettergi });
    if (!bettergi) {
      releaseLock();
      return {
        ok: false,
        error: '找不到 BetterGI.exe（可用 DSH_GAME_DAILY_BETTERGI 指到程序）',
      };
    }
  } else if (!isZzzDirect) {
    dsh = resolveDsh();
    if (!dsh) {
      releaseLock();
      return { ok: false, error: '找不到 dsh CLI，无法起 headless 运行' };
    }
  }

  // 当天幂等：排班触发时，先看**每日检查点**——
  //   · 今天确实做完且没有缺口 → 跳过，不再拉起游戏；
  //   · 上一轮 partial/failed 且这个游戏允许补跑 → 不跳过，按缺口补跑；
  //   · 不允许自动补跑的游戏（重跑也补不上，还白花体力）→ 跳过但在报告里写明差什么。
  if (trigger === 'schedule' && mode === 'real') {
    const decision = dailyDecision(stateDir, gameId, {
      resetHour: game.dailyResetHour,
      autoRetry: game.autoRetry,
    });
    // 手动补跑：DSH_GAME_DAILY_FORCE=1 时无视幂等（用户明确要求「把没做完的补一下」）。
    const forced = /^(1|true|yes|on)$/i.test(String(process.env.DSH_GAME_DAILY_FORCE || ''));
    if (decision.skip && !forced) {
      const runId = newRunId();
      const runDir = runDirOf(stateDir, gameId, runId);
      fs.mkdirSync(runDir, { recursive: true });
      const reportPath = reportPathOf(stateDir, gameId, runId);
      const gaps = decision.gaps.length ? decision.gaps.join('、') : '';
      const now = new Date().toISOString();
      // meta 也要写：不然 reconcile 读到空 meta，会把这条排班记录当成「手动运行」，
      // startedAt 也是空的，既挤掉真实历史，又在面板上显示成手动触发。
      try {
        writeJson(metaPathOf(stateDir, gameId, runId), {
          runId,
          gameId,
          gameTitle: game.title,
          mode,
          trigger,
          engine: game.engine,
          startedAt: now,
          finishedAt: now,
          exitCode: 0,
          skipped: true,
        });
      } catch {
        /* ignore */
      }
      try {
        writeJson(reportPath, {
          schemaVersion: 1,
          runId,
          game: gameId,
          mode,
          status: 'success',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          steps: [
            {
              name: decision.reason,
              ok: true,
              detail: gaps ? `还差：${gaps}` : '',
            },
          ],
          evidence: [
            'skipped=already-done',
            `reason=${decision.reason}`,
            `gaps=${gaps || 'none'}`,
            `attempts=${decision.retries}`,
          ],
          screenshots: [],
          notes: gaps
            ? `今天已经跑过，但还差：${gaps}。${decision.reason}。`
            : `今天已经跑过（${decision.reason}），本次没有重复拉起游戏。`,
          generatedBy: 'runner-idempotent-skip',
        });
      } catch {
        /* ignore */
      }
      releaseLock();
      return { ok: true, skipped: true, runId, runDir };
    }
    if (decision.gaps.length) {
      appendLog(
        path.join(stateDir, 'automation', 'run-headless.log'),
        `# ${new Date().toISOString()} ${gameId}: 补跑（还差：${decision.gaps.join('、')}）\n`,
      );
    }
  }

  const runId = newRunId();
  const runDir = runDirOf(stateDir, gameId, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const reportPath = reportPathOf(stateDir, gameId, runId);
  const overlay = isM7a ? { ok: false, error: 'm7a 引擎不使用 headless overlay' } : ensureOverlay({ stateDir, game });
  const prompt = isM7a
    ? ''
    : buildRunPrompt({
        game,
        mode,
        runId,
        runDir,
        reportPath,
        skillsRoot,
        stateDir,
      });

  const meta = {
    runId,
    gameId,
    gameTitle: game.title,
    mode,
    trigger,
    profile: isM7a ? 'm7a' : profile,
    engine: game.engine,
    startedAt: new Date().toISOString(),
    ...(isM7a
      ? { m7aExe: m7a.exe, m7aTasks, powerPlan: powerPlanInfo }
      : { promptChars: prompt.length, overlay: overlay.ok ? overlay.file : '', overlayError: overlay.ok ? '' : overlay.error }),
  };
  writeJson(metaPathOf(stateDir, gameId, runId), meta);

  const args = isM7a ? m7aTasks : isDirect ? [] : [...dsh.args, '--profile', profile];
  if (!isM7a && !isDirect && overlay.ok) args.push('--patch', overlay.file);
  if (!isM7a && !isDirect) args.push(prompt);

  const logFile = stdoutPathOf(stateDir, gameId, runId);
  appendLog(
    logFile,
    `# ${new Date().toISOString()} start ${gameId} ${mode} engine=${game.engine} ${isM7a ? `tasks=${m7aTasks.join('+')}` : `promptChars=${prompt.length}`}\n`,
  );

  // 用户要求：进入下一个游戏的日常前，先确保上一个游戏已经退出（减少后台占用、避免抢窗口）。
  // 演练模式不碰游戏，也就不做清理。
  if (mode === 'real') {
    try {
      const closedBefore = closeOtherGames(gameId);
      meta.preCleanup = closedBefore;
      appendLog(logFile, `# pre-run cleanup: ${closedBefore.length ? JSON.stringify(closedBefore) : 'no other game running'}\n`);
    } catch (error) {
      appendLog(logFile, `# pre-run cleanup failed: ${String((error && error.message) || error)}\n`);
    }
    writeJson(metaPathOf(stateDir, gameId, runId), meta);
  }

  // 绝区零走一条龙：真实运行前确保后端在跑（不在就启动，可能弹一次 UAC）。
  if (mode === 'real' && game.engine === 'zzz-direct') {
    try {
      const server = await ensureZzzServer({ timeoutSeconds: 45, stopFile: path.join(stateDir, 'automation', 'zzz-server.stop') });
      meta.zzzServer = { ok: server.ok, alreadyRunning: server.alreadyRunning === true, error: server.error };
      appendLog(logFile, `# zzz server: ${JSON.stringify(meta.zzzServer)}\n`);
    } catch (error) {
      meta.zzzServer = { ok: false, error: String((error && error.message) || error) };
      appendLog(logFile, `# zzz server start failed: ${meta.zzzServer.error}\n`);
    }
    writeJson(metaPathOf(stateDir, gameId, runId), meta);
  }

  const env = {
    ...process.env,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_GAME_DAILY_STATE_DIR: stateDir,
  };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

  let child;
  // 多任务时用的临时 .cmd：跑完要删掉，否则 %TEMP% 里越积越多。
  const m7aBatch = isM7a && m7aTasks.length > 1 ? m7aBatchFile(m7a, m7aTasks) : '';
  watchM7aLoginScreen.stateDir = stateDir;
  try {
    if (isBettergi) {
      // 直连 BetterGI 的「一条龙」命令行：脚本负责拉起游戏、释放单实例、跑一条龙并解析日志。
      const pluginState = readJsonSafe(path.join(stateDir, 'state.json')) || {};
      const gameState = pluginState.games && pluginState.games[gameId] ? pluginState.games[gameId] : {};
      // 前置配置组（默认「每日委托」）：BetterGI 的一条龙没有委托任务，
      // 不先做委托，「领取每日奖励」就永远领不到 90 原石。
      const groupsEnv = String(process.env.DSH_GAME_DAILY_BETTERGI_GROUPS || '').trim();
      const groupsCfg = String(gameState.oneDragonGroups || '').trim();
      let groups = (groupsEnv || groupsCfg)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      // state.json 里的 oneDragonGroups 会被 DSH 用内存副本整份覆盖掉（面板改的和落盘的不是同一个对象），
      // 排班跑的时候经常是空的 → 委托不跑 → 每日奖励永远领不到。
      // 兜底：BetterGI 的配置组目录里带「委托」的组就是它（默认「每日委托」）。
      if (!groups.length) {
        groups = detectCommissionGroups(bettergi.root);
        if (groups.length) {
          appendLog(
            path.join(stateDir, 'automation', 'commission-groups.log'),
            `# ${new Date().toISOString()} ${gameId}: state 里没有配置组，改用配置组目录里的：${groups.join('、')}\n`,
          );
        }
      }
      const args = [
        path.join(pluginRoot(), 'automation', 'run-bettergi.mjs'),
        '--root',
        bettergi.root,
        '--config',
        bettergiConfigName(game, gameState),
        '--game',
        gameId,
        '--mode',
        mode,
        '--run-id',
        runId,
        // 不传的话 run-bettergi.mjs 会用默认的 60 分钟，
        // 面板/排班给原神配的是 150 分钟 —— 超时会被腰斩在秘境刷到一半的时候。
        '--timeout-min',
        String(Math.max(5, Number(timeoutMin) || 60)),
        '--state-dir',
        stateDir,
      ];
      if (groups.length) {
        // 社区委托脚本的流程目录会被脚本更新覆盖，跑之前先补回来。
        // 类型（战斗/采集）用记住的：同名委托的类型固定，昨天认过一次今天就能用对的流程。
        const flows = ensureCommissionFlows(bettergi.root, pluginRoot(), {
          types: loadCommissionTypes(stateDir),
        });
        appendLog(
          path.join(stateDir, 'automation', 'commission-flows.log'),
          `# ${new Date().toISOString()} ${gameId}: ${JSON.stringify(flows)}\n`,
        );
        args.push('--groups', groups.join(','));
      }
      child = spawn(resolveNodeExe(), args, { cwd: stateDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    } else if (isZzzDirect) {
      // 直连一条龙后端：脚本负责起后端、跑一条龙、汇总应用记录。
      child = spawn(
        resolveNodeExe(),
        [
          path.join(pluginRoot(), 'automation', 'run-zzz.mjs'),
          '--game',
          gameId,
          '--mode',
          mode,
          '--run-id',
          runId,
          '--timeout-min',
          String(Math.max(5, Number(timeoutMin) || 60)),
        ],
        { cwd: stateDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env },
      );
    } else {
      child = isM7a
        ? m7aTasks.length > 1
          ? // 多个任务按顺序串起来（power 先刷体力、daily 再领奖），共用同一个 stdin 与退出码。
            // 不直接用 cmd /c 拼字符串（引号规则会把带空格的路径吃掉），改成写一份临时 .cmd 再执行。
            spawn('cmd.exe', ['/d', '/c', m7aBatch], {
              cwd: m7a.root,
              windowsHide: true,
              stdio: ['pipe', 'pipe', 'pipe'],
              env,
            })
          : spawn(m7a.exe, m7aTasks, {
              cwd: m7a.root,
              windowsHide: true,
              // stdin 必须是 pipe：M7A 收尾会「按回车键关闭窗口」，
              // 若是 ignore/closed，它读到的是 EOF，会抛 EOFError 并以退出码 1 结束。
              stdio: ['pipe', 'pipe', 'pipe'],
              env,
            })
        : spawn(dsh.command, args, {
            cwd: stateDir,
            shell: dsh.kind === 'cmd',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env,
          });
    }
  } catch (error) {
    const message = String((error && error.message) || error);
    writeJson(reportPath, fallbackReport({ gameId, mode, runId, exitCode: -1, logTail: message }));
    releaseLock();
    return { ok: false, error: message, runId };
  }

  // 定期给 M7A 递一根回车，消掉它各种「按回车继续」的等待（否则收尾会 EOF 崩）。
  let m7aEnterTimer = null;
  if (isM7a) {
    const ping = () => {
      try {
        if (child.stdin && !child.stdin.destroyed) child.stdin.write('\n');
      } catch {
        /* ignore */
      }
    };
    setTimeout(ping, 2000);
    m7aEnterTimer = setInterval(ping, 15000);
  }

  const pid = child.pid;
  writeJson(pidPath(stateDir, gameId), {
    pid,
    runId,
    mode,
    trigger,
    startedAt: meta.startedAt,
    engine: game.engine,
    ...(isM7a ? { m7aExe: m7a.exe, m7aTasks } : isBettergi ? { bettergiExe: bettergi.exe } : isZzzDirect ? {} : { dshBin: dsh.bin }),
  });
  appendLog(
    logFile,
    `# spawned pid=${pid} via ${
      isM7a ? m7a.exe : isBettergi ? 'run-bettergi.mjs' : isZzzDirect ? 'run-zzz.mjs' : `${dsh.kind} ${dsh.bin}`
    }\n`,
  );

  // 顺手起前台守护：游戏被别的窗口抢走时 1 秒内拉回（可被 ui.foregroundGuard 关掉）。
  // 直连引擎（BetterGI / M7A / 一条龙后端）自己管理窗口焦点，多一个守护进程只会互相抢焦点。
  // —— 但有两个例外，都是实测踩出来的：
  //    · 原神：BetterGI 的「地图追踪」只在**前台窗口是原神**时才推进，
  //      否则日志里就是「当前获取焦点的窗口为: XXX，不是原神，暂停」，委托流程会一直卡在寻路上。
  //    · 星铁：M7A 自己激活游戏窗口会失败（2026-11-04 实测 16 条
  //      「failed to set window foreground after multiple attempts」），体力计划整段被跳过。
  // 所以这两路都要开守护，把游戏拉回前台。
  let guardInfo = { ok: false, skipped: true };
  if (guard && (!isDirect || game.engine === 'bettergi' || game.engine === 'm7a')) {
    guardInfo = startForegroundGuard({
      stateDir,
      game,
      maxMinutes: Math.max(5, Number(timeoutMin) || 90) + 10,
    });
    appendLog(
      logFile,
      `# foreground guard ${guardInfo.ok ? `started pid=${guardInfo.pid}` : `failed: ${guardInfo.error}`}\n`,
    );
  }

  const decode = makeChildDecoder();
  child.stdout.on('data', (chunk) => {
    const text = decode(chunk);
    appendLog(logFile, text);
    if (isM7a) watchM7aLoginScreen(text, game);
  });
  child.stderr.on('data', (chunk) => appendLog(logFile, decode(chunk)));
  child.on('error', (error) => {
    const message = String((error && error.message) || error);
    appendLog(logFile, `# spawn error: ${message}\n`);
    releaseLock();
    removeTempFile(m7aBatch);
    // requireAdministrator 的程序在普通权限下连 CreateProcess 都会被拒（EACCES）。
    // 这种时候必须留下报告，否则面板会一直显示「没有结果」。
    if ((/EACCES|EPERM/i.test(message) || message.includes('accelerator')) && !fs.existsSync(reportPath)) {
      try {
        const built = m7aReport({
          gameId,
          mode,
          runId,
          exitCode: -1,
          startedAt: meta.startedAt,
          logText: message,
          resetHour: game.dailyResetHour,
        });
        built.notes = [
          '启动失败：March7thAssistant 需要管理员权限（requireAdministrator），当前进程是普通权限。',
          '从计划任务（最高权限）运行不会弹窗；手动「立即运行一次」时请让 DSH 以管理员身份启动，或先注册计划任务。',
          message,
        ].join('\n');
        built.status = 'failed';
        writeJson(reportPath, built);
        fs.rmSync(pidPath(stateDir, gameId), { force: true });
      } catch {
        /* ignore */
      }
    }
  });
  child.on('exit', (code) => {
    if (m7aEnterTimer) clearInterval(m7aEnterTimer);
    stopForegroundGuard(stateDir, gameId);
    unregisterQueue(stateDir, gameId);
    releaseLock();
    removeTempFile(m7aBatch);
    const finishedAt = new Date().toISOString();

    // 报告要**先写**：看门狗（run-headless）每 5 秒查一次「进程还在不在」，
    // 进程一退出它就去读 report.json —— 报告晚写几秒就被判成「没有报告」（2026-11-04 实测）。
    writeRunReport({ stateDir, gameId, runId, mode, exitCode: code, startedAt: meta.startedAt, logFile, reportPath, game, isM7a });

    // 收尾（关游戏、确认退出、写 meta）放后面异步做，不挡报告。
    void (async () => {
      let cleanup = [];
      if (mode === 'real') {
        try {
          // 关完还要确认：BetterGI 有时会在几十秒后自己再起一个实例、把原神也拉回来。
          const closed = await closeGameAndVerify(gameId);
          cleanup = closed.results;
          appendLog(
            logFile,
            `# close ${gameId}: ${JSON.stringify(cleanup)}${closed.stillRunning ? '（仍然在运行！）' : ''}\n`,
          );
        } catch (error) {
          appendLog(logFile, `# close ${gameId} failed: ${String((error && error.message) || error)}\n`);
        }
      }
      // 绝区零：游戏是提权进程，普通权限杀不掉，交给提权后的后端自己关；随后再停后端。
      if (mode === 'real' && game.engine === 'zzz-direct') {
        try {
          const closed = await zzzCloseGame({ timeoutMs: 15000 });
          appendLog(logFile, `# zzz close game via backend: ${JSON.stringify(closed)}\n`);
          for (let i = 0; i < 12; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            // runningGames() 返回的是 {gameId: bool}，不是数组 —— 之前 .map 会直接抛
            // TypeError，于是「等游戏真的关掉」这步从来没生效。
            const running = runningGames() || {};
            if (running[gameId] !== true) break;
          }
          const res = closeGame(gameId).results;
          appendLog(logFile, `# close ${gameId} after backend close: ${JSON.stringify(res)}\n`);
          try {
            const metaFile = metaPathOf(stateDir, gameId, runId);
            const current = readJsonSafe(metaFile) || meta;
            writeJson(metaFile, { ...current, cleanup: res });
          } catch { /* ignore */ }
        } catch (error) {
          appendLog(logFile, `# zzz close failed: ${String((error && error.message) || error)}\n`);
        }
        try {
          const stopped = await stopZzzServer({ stateDir, timeoutSeconds: 20 });
          appendLog(logFile, `# zzz server stop: ${JSON.stringify(stopped)}\n`);
        } catch (error) {
          appendLog(logFile, `# zzz server stop failed: ${String((error && error.message) || error)}\n`);
        }
      }
      try {
        const current = readJsonSafe(metaPathOf(stateDir, gameId, runId)) || meta;
        writeJson(metaPathOf(stateDir, gameId, runId), { ...current, finishedAt, exitCode: code, cleanup });
      } catch {
        /* ignore */
      }
    })();

    try {
      fs.rmSync(pidPath(stateDir, gameId), { force: true });
    } catch {
      /* ignore */
    }
  });

  return { ok: true, runId, pid, runDir, startedAt: meta.startedAt, guard: guardInfo };
}

/** 停止某游戏正在跑的一轮（taskkill /T /F，连同子进程）。 */
export function stopRun({ stateDir, gameId }) {
  stopForegroundGuard(stateDir, gameId);
  const info = readRunner(stateDir, gameId);
  if (!info) return { ok: false, error: '没有正在跑的运行' };
  if (!info.running) {
    try {
      fs.rmSync(pidPath(stateDir, gameId), { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, error: `记录的进程 ${info.pid} 已经退出` };
  }
  try {
    execFileSync('taskkill.exe', ['/PID', String(info.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  try {
    fs.rmSync(pidPath(stateDir, gameId), { force: true });
  } catch {
    /* ignore */
  }
  return { ok: true, killed: info.pid, runId: info.runId };
}
