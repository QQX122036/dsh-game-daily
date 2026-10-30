#!/usr/bin/env node
// 原神「一条龙」直连执行器（计划任务/插件的子进程）。
//
// 流程：
//   1) 游戏没跑 → 先用 BetterGI 的 GUI 模式联动拉起游戏，等窗口出现；
//   2) 释放 BetterGI 单实例（GUI 占着时，命令行触发只会被转发不会执行）；
//   3) 跑 `BetterGI.exe startOneDragon <配置>`；
//   4) 从 BetterGI 日志增量里提炼报告，末行打印 "##REPORT {json}" 给 runner。
//
// 这个脚本必须以管理员权限运行（BetterGI 与原神都是提权进程）；
// 计划任务以「最高权限」触发时天然满足，手动运行时由 runner 负责报错提示。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { bettergiLogFile, bettergiReport } from '../lib/bettergi.mjs';

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function parseArgs(argv) {
  const out = { root: 'D:\\software\\BetterGI', config: '日常', gameId: 'genshin', mode: 'real', runId: '', timeoutMin: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--root') out.root = argv[++i];
    else if (token === '--config') out.config = argv[++i];
    else if (token === '--game') out.gameId = argv[++i];
    else if (token === '--mode') out.mode = argv[++i];
    else if (token === '--run-id') out.runId = argv[++i];
    else if (token === '--timeout-min') out.timeoutMin = Number(argv[++i]) || 60;
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => process.stdout.write(`[bettergi] ${text}\n`);

function gameWindowTitle() {
  try {
    const out = execFileSync(
      PS,
      ['-NoProfile', '-NonInteractive', '-Command', "(Get-Process YuanShen -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1).MainWindowTitle"],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    );
    return String(out || '').trim();
  } catch {
    return '';
  }
}

function killBettergi() {
  try {
    execFileSync('taskkill.exe', ['/F', '/IM', 'BetterGI.exe'], { windowsHide: true, timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

function readSince(file, sizeBefore) {
  try {
    const stat = fs.statSync(file);
    if (stat.size <= sizeBefore) return '';
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - sizeBefore);
    fs.readSync(fd, buffer, 0, buffer.length, sizeBefore);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exe = path.join(args.root, 'BetterGI.exe');
  if (!fs.existsSync(exe)) {
    log(`找不到 ${exe}`);
    process.stdout.write(`##REPORT ${JSON.stringify(bettergiReport({ gameId: args.gameId, mode: args.mode, runId: args.runId, exitCode: -1, startedAt: new Date().toISOString(), logText: '' }))}\n`);
    process.exit(1);
  }

  const startedAt = new Date().toISOString();

  // 1) 确保游戏在跑
  if (!gameWindowTitle()) {
    log('游戏未运行：用 BetterGI 联动启动');
    try {
      spawn(exe, ['start'], { detached: true, stdio: 'ignore' }).unref();
    } catch (error) {
      log(`启动失败：${String((error && error.message) || error)}`);
    }
    const deadline = Date.now() + Math.max(30, Number(args.timeoutMin) || 60) * 1000;
    while (Date.now() < deadline && !gameWindowTitle()) await sleep(3000);
    if (!gameWindowTitle()) log('警告：游戏没有在 240 秒内出现');
    await sleep(10000);
  } else {
    log('游戏已在运行');
  }

  // 2) 释放单实例（GUI 模式占着时命令行触发不会真正执行）
  if (killBettergi()) log('已结束 BetterGI GUI 实例（释放单实例）');
  await sleep(4000);

  // 3) 跑一条龙
  const logFile = bettergiLogFile(args.root);
  let sizeBefore = 0;
  try {
    sizeBefore = fs.statSync(logFile).size;
  } catch {
    sizeBefore = 0;
  }
  log(`开始一条龙：startOneDragon ${args.config}`);
  const started = Date.now();
  const child = spawn(exe, ['startOneDragon', args.config], { cwd: args.root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.on('error', (error) => {
    log(`启动失败：${String((error && error.message) || error)}`);
    process.stdout.write(`##REPORT ${JSON.stringify(bettergiReport({ gameId: args.gameId, mode: args.mode, runId: args.runId, exitCode: -1, startedAt, logText: '' }))}\n`);
    process.exit(1);
  });
  const DONE_MARKER = '一条龙和配置组任务结束';
  const timeoutMs = Math.max(10, Number(args.timeoutMin) || 60) * 60 * 1000;
  let finished = false;

  const finish = (code, reason) => {
    if (finished) return;
    finished = true;
    clearInterval(watchdog);
    const text = readSince(logFile, sizeBefore);
    if (reason) log(reason);
    // BetterGI 跑完任务后 GUI 仍驻留，这里收掉它（它是我们自己拉起的）。
    try {
      execFileSync('taskkill.exe', ['/F', '/IM', 'BetterGI.exe'], { windowsHide: true, timeout: 20000 });
    } catch {
      /* ignore */
    }
    const report = bettergiReport({
      gameId: args.gameId,
      mode: args.mode,
      runId: args.runId,
      exitCode: code == null ? -1 : code,
      startedAt,
      logText: text,
    });
    process.stdout.write(`##REPORT ${JSON.stringify(report)}\n`);
    process.exit(0);
  };

  // BetterGI 的 GUI 跑完一条龙不会退出，所以不能只等进程退出：
  // 以日志里的收尾标记为准，同时保留进程退出与超时两条兜底。
  const watchdog = setInterval(() => {
    const text = readSince(logFile, sizeBefore);
    if (text.includes(DONE_MARKER)) finish(0, '检测到一条龙收尾标记');
    else if (Date.now() - started > timeoutMs) finish(-1, `超过 ${args.timeoutMin || 60} 分钟仍未收尾，放弃等待`);
  }, 5000);

  child.on('exit', (code) => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    const text = readSince(logFile, sizeBefore);
    if (elapsed < 15 && !text.includes(DONE_MARKER)) {
      log(`进程 ${elapsed}s 就退出（code=${code}），多半是 BetterGI 提权重启了（退出码 553），本次没有接管。`);
    }
    finish(code, 'BetterGI 进程已退出');
  });
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
