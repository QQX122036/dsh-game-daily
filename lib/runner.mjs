// 起一轮 headless 运行（计划任务与「立即运行一次」共用同一条路）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDsh } from './deps.mjs';
import { gameById } from './games.mjs';
import { buildRunPrompt } from './prompt.mjs';
import {
  newRunId,
  runDirOf,
  metaPathOf,
  reportPathOf,
  stdoutPathOf,
  readJsonSafe,
  writeJson,
} from './report.mjs';

/** bettergi MCP 服务器脚本：优先环境变量，其次取与插件同级的 dsh-betterGI 工作区。 */
function bettergiMcpScript() {
  const fromEnv = process.env.DSH_GAME_DAILY_BETTERGI_MCP;
  if (fromEnv) return fromEnv;
  return path.resolve(pluginRoot(), '..', 'dsh-betterGI', 'tools', 'bettergi-mcp', 'bettergi-mcp.mjs');
}

export function overlayPath(stateDir) {
  return path.join(stateDir, 'automation', 'headless-overlay.yml');
}

/** 插件根目录（判断 automation/ 里随包脚本的位置，兼容 link 安装）。 */
function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  const mcpScript = bettergiMcpScript();
  const mcpCwd = path.resolve(mcpScript, '..', '..', '..');
  const lines = ['# 由 dsh-game-daily 自动生成（每次运行前重写，勿手改）'];
  if (game && game.engine === 'bettergi' && fs.existsSync(mcpScript)) {
    const nodeCmd = process.versions.electron ? 'node' : process.execPath;
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
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  return { ok: true, file, hasMcp: lines.length > 1 };
}

function alive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
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
export function startRun({
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
  const dsh = resolveDsh();
  if (!dsh) return { ok: false, error: '找不到 dsh CLI，无法起 headless 运行' };

  const runId = newRunId();
  const runDir = runDirOf(stateDir, gameId, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const overlay = ensureOverlay({ stateDir, game });
  const reportPath = reportPathOf(stateDir, gameId, runId);
  const prompt = buildRunPrompt({
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
    profile,
    startedAt: new Date().toISOString(),
    promptChars: prompt.length,
    overlay: overlay.ok ? overlay.file : '',
    overlayError: overlay.ok ? '' : overlay.error,
  };
  writeJson(metaPathOf(stateDir, gameId, runId), meta);

  const args = [...dsh.args, '--profile', profile];
  if (overlay.ok) args.push('--patch', overlay.file);
  args.push(prompt);

  const logFile = stdoutPathOf(stateDir, gameId, runId);
  appendLog(logFile, `# ${new Date().toISOString()} start ${gameId} ${mode} pid=? promptChars=${prompt.length}\n`);

  const env = {
    ...process.env,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_GAME_DAILY_STATE_DIR: stateDir,
  };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

  let child;
  try {
    child = spawn(dsh.command, args, {
      cwd: stateDir,
      shell: dsh.kind === 'cmd',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  } catch (error) {
    const message = String((error && error.message) || error);
    writeJson(reportPath, fallbackReport({ gameId, mode, runId, exitCode: -1, logTail: message }));
    return { ok: false, error: message, runId };
  }

  const pid = child.pid;
  writeJson(pidPath(stateDir, gameId), {
    pid,
    runId,
    mode,
    trigger,
    startedAt: meta.startedAt,
    dshBin: dsh.bin,
  });
  appendLog(logFile, `# spawned pid=${pid} via ${dsh.kind} ${dsh.bin}\n`);

  // 顺手起前台守护：游戏被别的窗口抢走时 1 秒内拉回（可被 ui.foregroundGuard 关掉）。
  let guardInfo = { ok: false, skipped: true };
  if (guard) {
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
    appendLog(logFile, `# spawn error: ${String((error && error.message) || error)}\n`);
  });
  child.on('exit', (code) => {
    stopForegroundGuard(stateDir, gameId);
    const finishedAt = new Date().toISOString();
    try {
      const current = readJsonSafe(metaPathOf(stateDir, gameId, runId)) || meta;
      writeJson(metaPathOf(stateDir, gameId, runId), { ...current, finishedAt, exitCode: code });
    } catch {
      /* ignore */
    }
    if (!fs.existsSync(reportPath)) {
      let tail = '';
      try {
        tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n');
      } catch {
        tail = '';
      }
      try {
        writeJson(reportPath, fallbackReport({ gameId, mode, runId, exitCode: code, logTail: tail }));
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
