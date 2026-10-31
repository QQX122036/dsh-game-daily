// 起一轮 headless 运行（计划任务与「立即运行一次」共用同一条路）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDsh } from './deps.mjs';
import { businessDay, businessDayOfRunId, DEFAULT_RESET_HOUR } from './dailycycle.mjs';
import { mergeReport, dailyDecision, dailySummary } from './daily-state.mjs';
import { resolveM7a, resolveM7aTasks, m7aReport, ensurePowerPlan } from './m7a.mjs';
import { resolveBettergi, bettergiConfigName } from './bettergi.mjs';
import { resolveNodeExe } from './nodeexe.mjs';
import { gameById } from './games.mjs';
import { buildRunPrompt } from './prompt.mjs';
import { resolveBettergiMcp } from './bettergi-mcp.mjs';
import { ensureZzzServer, stopZzzServer, zzzCloseGame, zzzRoot, zzzBaseUrl } from './zzz.mjs';
import { closeGame, closeOtherGames, runningGames, GAME_PROCESSES } from './gameproc.mjs';
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
 * 把 M7A 的多个任务写成一份临时 .cmd，按顺序执行。
 * 走批处理而不是 cmd /c 拼字符串：cmd 的引号规则会吃掉带空格的路径。
 */
function m7aBatchFile(m7a, tasks) {
  const file = path.join(os.tmpdir(), `gd-m7a-${process.pid}-${Date.now()}.cmd`);
  const body = tasks.map((task) => `"${m7a.exe}" ${task}`).join('\r\n');
  fs.writeFileSync(file, `@echo off\r\n${body}\r\n`, 'utf8');
  return file;
}

export function guardScriptPath() {
  return path.join(pluginRoot(), 'automation', 'keep-foreground.ps1');
}

// 每个游戏同时最多一个守护进程；key=gameId
const guards = new Map();

/** 运行期间盯前台：游戏被别的窗口抢走就 1 秒内拉回。守护脚本随包分发。 */
export function startForegroundGuard({ stateDir, game, maxMinutes = 150, intervalMs = 1000 }) {
  const script = guardScriptPath();
  if (!fs.existsSync(script)) return { ok: false, error: `前台守护脚本缺失：${script}` };
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
 */
export function acquireRunLock(stateDir, { waitMs = 20 * 60 * 1000 } = {}) {
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
      sleepSync(3000);
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
  } else if (game && game.engine === 'zzz-od') {
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
  let runLock = null;
  if (mode === 'real') {
    const waitMs = Math.max(0, Number(process.env.DSH_GAME_DAILY_WAIT_MS) || 20 * 60 * 1000);
    runLock = acquireRunLock(stateDir, { waitMs });
    if (!runLock.ok) return { ok: false, error: runLock.error };
  }
  const releaseLock = () => {
    if (runLock && runLock.release) {
      runLock.release();
      runLock = null;
    }
  };
  // 上一款游戏还在跑时不要抢：计划任务会等它收尾（最长 20 分钟），手动运行直接报错。
  if (mode === 'real') {
    const busyNow = () =>
      Object.keys(GAME_PROCESSES).filter((otherId) => otherId !== gameId && isRunning(stateDir, otherId));
    let busy = busyNow();
    if (busy.length) {
      if (trigger !== 'schedule') {
        const titles = busy.map((id) => (gameById(id) || { title: id }).title).join('、');
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
        return { ok: false, error: `${titles} 的日常超过等待上限还没结束，跳过本轮` };
      }
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
    if (decision.skip) {
      const runId = newRunId();
      const runDir = runDirOf(stateDir, gameId, runId);
      fs.mkdirSync(runDir, { recursive: true });
      const reportPath = reportPathOf(stateDir, gameId, runId);
      const gaps = decision.gaps.length ? decision.gaps.join('、') : '';
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
  if (mode === 'real' && game.engine === 'zzz-od') {
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
  try {
    if (isBettergi) {
      // 直连 BetterGI 的「一条龙」命令行：脚本负责拉起游戏、释放单实例、跑一条龙并解析日志。
      child = spawn(
        resolveNodeExe(),
        [
          path.join(pluginRoot(), 'automation', 'run-bettergi.mjs'),
          '--root',
          bettergi.root,
          '--config',
          bettergiConfigName(game, (readJsonSafe(path.join(stateDir, 'state.json')) || {}).games?.[gameId]),
          '--game',
          gameId,
          '--mode',
          mode,
          '--run-id',
          runId,
        ],
        { cwd: stateDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env },
      );
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
            spawn('cmd.exe', ['/d', '/c', m7aBatchFile(m7a, m7aTasks)], {
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
  let guardInfo = { ok: false, skipped: true };
  if (guard && !isDirect) {
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

  child.stdout.on('data', (chunk) => appendLog(logFile, String(chunk)));
  child.stderr.on('data', (chunk) => appendLog(logFile, String(chunk)));
  child.on('error', (error) => {
    const message = String((error && error.message) || error);
    appendLog(logFile, `# spawn error: ${message}\n`);
    releaseLock();
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
    releaseLock();
    const finishedAt = new Date().toISOString();
    // 跑完就把游戏关掉（用户要求：日常做完退出游戏，减少后台占用）。演练模式不碰游戏。
    let cleanup = [];
    if (mode === 'real') {
      try {
        cleanup = closeGame(gameId).results;
        appendLog(logFile, `# close ${gameId}: ${JSON.stringify(cleanup)}\n`);
      } catch (error) {
        appendLog(logFile, `# close ${gameId} failed: ${String((error && error.message) || error)}\n`);
      }
    }
    // 绝区零：游戏是提权进程，普通权限杀不掉，交给提权后的后端自己关；随后再停后端。
    if (mode === 'real' && game.engine === 'zzz-od') {
      void (async () => {
        try {
          const closed = await zzzCloseGame({ timeoutMs: 15000 });
          appendLog(logFile, `# zzz close game via backend: ${JSON.stringify(closed)}\n`);
          const names = (GAME_PROCESSES.zzz || []).map((n) => n.toLowerCase());
          for (let i = 0; i < 12; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const running = runningGames().map((n) => String(n).toLowerCase());
            if (!running.some((n) => names.includes(n))) break;
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
      })();
    }
    try {
      const current = readJsonSafe(metaPathOf(stateDir, gameId, runId)) || meta;
      writeJson(metaPathOf(stateDir, gameId, runId), { ...current, finishedAt, exitCode: code, cleanup });
    } catch {
      /* ignore */
    }
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
                exitCode: code,
                startedAt: meta.startedAt,
                logText: text,
                resetHour: game.dailyResetHour,
              })
            : fallbackReport({ gameId, mode, runId, exitCode: code, logTail: text.split('\n').slice(-40).join('\n') }),
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
