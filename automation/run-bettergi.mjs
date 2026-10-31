#!/usr/bin/env node
// 原神「一条龙」直连执行器（计划任务/插件的子进程）。
//
// 实测结论（2026-10-31）：`BetterGI.exe startOneDragon <配置>` 冷启动会自己
// 拉起原神并进入一条龙（约 4.5 分钟，含游戏启动与登录），所以这里只需三步：
//   1) 若已有 BetterGI 实例在跑先结束它——单实例会把命令行参数只做转发、不会真正执行；
//   2) 直接跑 `startOneDragon`；
//   3) 以日志里的收尾标记「一条龙和配置组任务结束」为准产出报告
//      （BetterGI 跑完后 GUI 会驻留，不能只等进程退出，否则会挂到超时），
//      收尾时结束我们自己拉起的 BetterGI。
//
// 这个脚本必须以管理员权限运行（BetterGI 与原神都是提权进程）；
// 计划任务以「最高权限」触发时天然满足，手动运行时由 runner 负责报错提示。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { bettergiLogFile, bettergiReport } from '../lib/bettergi.mjs';

const DONE_MARKER = '一条龙和配置组任务结束';

function parseArgs(argv) {
  const out = {
    root: 'D:\\software\\BetterGI',
    config: '日常',
    gameId: 'genshin',
    mode: 'real',
    runId: '',
    timeoutMin: 60,
  };
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

/**
 * 按「文件 → 已读到的位置」跟踪日志增量。
 *
 * BetterGI 的日志**按天切文件**（better-genshin-impactYYYYMMDD.log）。
 * 22:0x 起跑、00:0x 收尾时，收尾标记会写进第二天那个文件 ——
 * 只盯着起跑那天的文件，就永远读不到收尾标记，只能干等到超时。
 */
function createLogReader(root) {
  const offsets = new Map();
  const startFile = bettergiLogFile(root);
  offsets.set(startFile, 0);
  try {
    offsets.set(startFile, fs.statSync(startFile).size);
  } catch {
    /* ignore */
  }
  return {
    /** 读取自上次以来新增的内容（跨零点会自动带上新文件）。 */
    read() {
      let text = '';
      const current = bettergiLogFile(root);
      if (!offsets.has(current)) offsets.set(current, 0);
      for (const [file, before] of [...offsets.entries()]) {
        const chunk = readSince(file, before);
        if (chunk) text += chunk;
        try {
          offsets.set(file, fs.statSync(file).size);
        } catch {
          /* ignore */
        }
      }
      return text;
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exe = path.join(args.root, 'BetterGI.exe');
  if (!fs.existsSync(exe)) {
    log(`找不到 ${exe}`);
    process.stdout.write(
      `##REPORT ${JSON.stringify(
        bettergiReport({ gameId: args.gameId, mode: args.mode, runId: args.runId, exitCode: -1, startedAt: new Date().toISOString(), logText: '' }),
      )}\n`,
    );
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();

  // 演练模式（dry）只做环境自检：不启动游戏、不跑一条龙、不碰 BetterGI 实例。
  // 之前脚本收了 --mode 却从没用它，演练会真的开跑 —— 这是必须堵住的红线。
  if (args.mode === 'dry') {
    const logFile = bettergiLogFile(args.root);
    let logExists = false;
    let logSize = 0;
    try {
      const stat = fs.statSync(logFile);
      logExists = true;
      logSize = stat.size;
    } catch {
      /* ignore */
    }
    log('演练模式：不启动游戏、不执行一条龙。');
    process.stdout.write(
      `##REPORT ${JSON.stringify({
        schemaVersion: 1,
        runId: args.runId,
        game: args.gameId,
        mode: 'dry',
        status: 'partial',
        startedAt,
        endedAt: new Date().toISOString(),
        steps: [],
        evidence: [`dry=true`, `bettergi=${fs.existsSync(exe) ? 'found' : 'missing'}`, `config=${args.config}`, `log=${logExists ? `${logSize}B` : 'none'}`],
        screenshots: [],
        notes: [
          '演练模式：没有启动游戏、没有执行一条龙、没有任何游戏内操作。',
          `只做了环境自检：BetterGI=${fs.existsSync(exe) ? '已就位' : '没找到'}，一条龙配置「${args.config}」，今日日志=${logExists ? `${logSize} 字节` : '还没有'}。`,
          '把模式切成「真实执行」才会真的跑日常。',
        ].join('\n'),
        generatedBy: 'runner-bettergi',
      })}\n`,
    );
    process.exit(0);
  }

  // 1) 清掉可能残留的 BetterGI 实例（单实例会把命令行只做转发）
  if (killBettergi()) {
    log('已结束残留的 BetterGI 实例（释放单实例）');
    await sleep(3000);
  }

  // 2) 跑一条龙（冷启动会自己拉起游戏）
  const reader = createLogReader(args.root);
  log(`开始一条龙：startOneDragon ${args.config}（BetterGI 会自行拉起游戏）`);
  const child = spawn(exe, ['startOneDragon', args.config], { cwd: args.root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  let finished = false;
  let collected = '';
  const finish = (code, reason) => {
    if (finished) return;
    finished = true;
    clearInterval(watchdog);
    collected += reader.read();
    if (reason) log(reason);
    try {
      killBettergi();
    } catch {
      /* ignore */
    }
    const report = bettergiReport({
      gameId: args.gameId,
      mode: args.mode,
      runId: args.runId,
      exitCode: code == null ? -1 : code,
      startedAt,
      logText: collected,
    });
    process.stdout.write(`##REPORT ${JSON.stringify(report)}\n`);
    process.exit(0);
  };

  const timeoutMs = Math.max(10, Number(args.timeoutMin) || 60) * 60 * 1000;
  const watchdog = setInterval(() => {
    collected += reader.read();
    if (collected.includes(DONE_MARKER)) finish(0, '检测到一条龙收尾标记');
    else if (Date.now() - started > timeoutMs) finish(-1, `超过 ${args.timeoutMin || 60} 分钟仍未收尾，放弃等待`);
  }, 5000);

  child.on('error', (error) => {
    log(`启动失败：${String((error && error.message) || error)}`);
    finish(-1, 'BetterGI 启动失败');
  });
  child.on('exit', (code) => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    collected += reader.read();
    if (!collected.includes(DONE_MARKER) && elapsed < 300) {
      // BetterGI 冷启动会**提权重启自己**（父进程退出码 553），真正在跑一条龙的是新实例。
      // 早先这里直接 finish + killBettergi()，等于把正在跑的日常自己掐死，还报 failed。
      // 现在改成继续盯日志，最多再等 5 分钟收尾标记。
      log(`进程 ${elapsed}s 就退出（code=${code}）且没有收尾标记 —— 多半是 BetterGI 提权重启了自己，继续等新实例写日志。`);
      setTimeout(() => {
        if (finished) return;
        collected += reader.read();
        if (!collected.includes(DONE_MARKER)) finish(code, 'BetterGI 退出后 5 分钟内没有收尾标记');
      }, 5 * 60 * 1000);
      return;
    }
    finish(code, 'BetterGI 进程已退出');
  });
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
