#!/usr/bin/env node
// 绝区零「一条龙」直连执行器（计划任务/插件的子进程）。
//
// 流程：确保一条龙后端在跑 → POST /game/run/one-dragon → 轮询 /game/status
//      → 汇总应用执行记录 → 末行打印 "##REPORT {json}" 给 runner。
//
// 后端要管理员权限（游戏是提权进程），所以这个脚本必须以最高权限运行；
// 计划任务以「最高权限」触发时天然满足。
import path from 'node:path';
import { ensureZzzServer, stopZzzServer, zzzRoot, zzzBaseUrl, zzzHealthSync } from '../lib/zzz.mjs';
import { runZzzOneDragon } from '../lib/zzzrun.mjs';

function parseArgs(argv) {
  const out = { gameId: 'zzz', mode: 'real', runId: '', timeoutMin: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--game') out.gameId = argv[++i];
    else if (token === '--mode') out.mode = argv[++i];
    else if (token === '--run-id') out.runId = argv[++i];
    else if (token === '--timeout-min') out.timeoutMin = Number(argv[++i]) || 60;
  }
  return out;
}

const log = (text) => process.stdout.write(`[zzz] ${text}\n`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const root = zzzRoot();
  const baseUrl = zzzBaseUrl();

  log(`一条龙根目录：${root}`);

  // 演练模式（dry）只做诊断：不下发一条龙、不启动游戏、不做任何游戏内操作。
  // 之前脚本收了 --mode 却从没用它，演练会真的开跑 —— 这是必须堵住的红线。
  if (args.mode === 'dry') {
    const health = await zzzHealthSync({ timeoutMs: 3000 }).catch(() => ({ ok: false, error: '后端未响应' }));
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
        evidence: [`dry=true`, `backend=${health.ok ? 'up' : 'down'}`, `root=${root}`],
        screenshots: [],
        notes: [
          '演练模式：没有下发一条龙、没有启动游戏、没有任何游戏内操作。',
          `只做了环境自检：一条龙根目录=${root}，后端=${health.ok ? '在跑' : '没在跑'}。`,
          '把模式切成「真实执行」才会真的跑日常。',
        ].join('\n'),
        generatedBy: 'runner-zzz',
      })}\n`,
    );
    process.exit(0);
  }

  const server = await ensureZzzServer({ timeoutSeconds: 45 });
  if (!server.ok) {
    log(`后端起不来：${server.error || '未知原因'}`);
    process.stdout.write(
      `##REPORT ${JSON.stringify({
        schemaVersion: 1,
        runId: args.runId,
        game: args.gameId,
        mode: args.mode,
        status: 'failed',
        startedAt,
        endedAt: new Date().toISOString(),
        steps: [],
        evidence: ['backend=down'],
        screenshots: [],
        notes: `一条龙后端启动失败：${server.error || '未知原因'}。游戏是管理员权限，后端也需要最高权限运行（计划任务以最高权限触发即可）。`,
        generatedBy: 'runner-zzz',
      })}\n`,
    );
    process.exit(1);
  }
  log('后端已就绪');

  const result = await runZzzOneDragon({
    baseUrl,
    root,
    timeoutMs: Math.max(5, Number(args.timeoutMin) || 60) * 60 * 1000,
  });

  try {
    await stopZzzServer({ timeoutSeconds: 20 });
  } catch {
    /* ignore */
  }

  process.stdout.write(
    `##REPORT ${JSON.stringify({
      schemaVersion: 1,
      runId: args.runId,
      game: args.gameId,
      mode: args.mode,
      status: result.status,
      startedAt: result.startedAt || startedAt,
      endedAt: new Date().toISOString(),
      steps: result.steps,
      evidence: result.evidence,
      screenshots: [],
      notes: result.notes,
      generatedBy: 'runner-zzz',
    })}\n`,
  );
  // 退出码区分：0=成功、1=失败/超时。任务计划器里能一眼看出「没跑成」，
  // 以前恒为 0，失败在计划任务里完全看不出来。
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
