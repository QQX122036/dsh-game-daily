// 起一轮 headless 运行（计划任务与「立即运行一次」共用同一条路）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDsh } from './deps.mjs';
import { resolveM7a, resolveM7aTasks, m7aReport } from './m7a.mjs';
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
  pad2,
} from './report.mjs';

/**
 * 今天该游戏是否已经跑过（返回最近一次带报告的运行）。
 * 排班触发时用它做幂等：今天跑过就不重复拉起游戏（重复跑会白刷体力、白等一次登录）。
 */
export function todayRunStatus(stateDir, gameId, date = new Date()) {
  const prefix = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
  let names = [];
  try {
    names = fs
      .readdirSync(gameRunsDir(stateDir, gameId), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    const report = readReport(stateDir, gameId, name);
    if (report && (report.status === 'success' || report.status === 'partial')) {
      return { runId: name, status: report.status, finishedAt: report.endedAt || '' };
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
  let bettergi = null;
  if (isM7a) {
    const pluginState = readJsonSafe(path.join(stateDir, 'state.json')) || {};
    const configuredM7a =
      (pluginState.games && pluginState.games[gameId] && pluginState.games[gameId].m7aPath) || '';
    m7a = resolveM7a({ configured: configuredM7a });
    if (!m7a) {
      return {
        ok: false,
        error: '找不到 March7th Assistant.exe（可用 DSH_GAME_DAILY_M7A 指到程序或目录）',
      };
    }
    m7aTasks = resolveM7aTasks(game);
  } else if (isBettergi) {
    const pluginState = readJsonSafe(path.join(stateDir, 'state.json')) || {};
    const configuredBettergi =
      (pluginState.games && pluginState.games[gameId] && pluginState.games[gameId].bettergiPath) || '';
    bettergi = resolveBettergi({ configured: configuredBettergi });
    if (!bettergi) {
      return {
        ok: false,
        error: '找不到 BetterGI.exe（可用 DSH_GAME_DAILY_BETTERGI 指到程序）',
      };
    }
  } else if (!isZzzDirect) {
    dsh = resolveDsh();
    if (!dsh) return { ok: false, error: '找不到 dsh CLI，无法起 headless 运行' };
  }

  // 当天幂等：排班触发时，今天已经跑过就不再重复拉起游戏。
  if (trigger === 'schedule' && mode === 'real') {
    const done = todayRunStatus(stateDir, gameId);
    if (done) {
      const runId = newRunId();
      const runDir = runDirOf(stateDir, gameId, runId);
      fs.mkdirSync(runDir, { recursive: true });
      const reportPath = reportPathOf(stateDir, gameId, runId);
      try {
        writeJson(reportPath, {
          schemaVersion: 1,
          runId,
          game: gameId,
          mode,
          status: 'success',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          steps: [{ name: '今日已执行，按幂等规则跳过', ok: true, detail: `${done.runId} · ${done.status}` }],
          evidence: ['skipped=already-done', `prev=${done.runId}`, `prevStatus=${done.status}`],
          screenshots: [],
          notes: `今天已经跑过（${done.runId} · ${done.status}），本次没有重复拉起游戏。`,
          generatedBy: 'runner-idempotent-skip',
        });
      } catch {
        /* ignore */
      }
      return { ok: true, skipped: true, runId, runDir };
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
      ? { m7aExe: m7a.exe, m7aTasks }
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
    // requireAdministrator 的程序在普通权限下连 CreateProcess 都会被拒（EACCES）。
    // 这种时候必须留下报告，否则面板会一直显示「没有结果」。
    if ((/EACCES|EPERM/i.test(message) || message.includes('accelerator')) && !fs.existsSync(reportPath)) {
      try {
        const built = m7aReport({ gameId, mode, runId, exitCode: -1, startedAt: meta.startedAt, logText: message });
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
            ? m7aReport({ gameId, mode, runId, exitCode: code, startedAt: meta.startedAt, logText: text })
            : fallbackReport({ gameId, mode, runId, exitCode: code, logTail: text.split('\n').slice(-40).join('\n') }),
        );
      } catch {
        /* ignore */
      }
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
