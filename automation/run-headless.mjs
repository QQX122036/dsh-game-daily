#!/usr/bin/env node
// 计划任务入口：起一轮 headless 日常，等它跑完，读出报告后决定任务退出码。
// 参数：--game <id> --state-dir <dir> [--profile headless] [--mode real|dry] [--timeout-min 120] [--skills-root <dir>]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startRun, readRunner, isRunning, stopRun } from '../lib/runner.mjs';
import { readReport, reportPathOf, runDirOf, readJsonSafe, writeJson } from '../lib/report.mjs';
import { dailySummary } from '../lib/daily-state.mjs';
import { notify } from '../lib/notify.mjs';
import { gameById } from '../lib/games.mjs';

/** 读 state.json 里的插件级 UI 开关（前台守护）与该游戏的超时设置。 */
function readPluginState(stateDir) {
  const raw = readJsonSafe(path.join(stateDir, 'state.json'));
  return raw && typeof raw === 'object' ? raw : {};
}

function parseArgs(argv) {
  const out = { mode: 'real', profile: 'headless', timeoutMin: 120 };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--game') out.game = argv[++i];
    else if (token === '--state-dir') out.stateDir = argv[++i];
    else if (token === '--profile') out.profile = argv[++i];
    else if (token === '--mode') out.mode = argv[++i];
    else if (token === '--timeout-min') out.timeoutMin = Number(argv[++i]) || 120;
    else if (token === '--skills-root') out.skillsRoot = argv[++i];
  }
  return out;
}

function defaultSkillsRoot() {
  return process.env.DSH_SKILLS_ROOT || path.join(os.homedir(), '.agents', 'skills');
}

function log(stateDir, text) {
  const line = `[${new Date().toISOString()}] ${text}\n`;
  process.stdout.write(line);
  try {
    fs.mkdirSync(path.join(stateDir, 'automation'), { recursive: true });
    fs.appendFileSync(path.join(stateDir, 'automation', 'run-headless.log'), line, 'utf8');
  } catch {
    /* ignore */
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.game || !args.stateDir) {
    console.error('usage: node run-headless.mjs --game <id> --state-dir <dir>');
    process.exit(2);
  }
  const stateDir = path.resolve(args.stateDir);
  const game = gameById(args.game);
  if (!game) {
    console.error(`未知游戏：${args.game}`);
    process.exit(2);
  }
  log(stateDir, `scheduled run start game=${args.game} mode=${args.mode} profile=${args.profile}`);

  // 日常凌晨重置（米哈游 4 点）。在重置之前触发的那一轮，做的其实是**昨天**的日常，
  // 而且会把工具里「今天已做过」的状态写坏 —— 真正的那一天反而跑不到
  // （今天 00:05 那轮把原神的秘境/合成台用掉了，22:07 那轮直接跳过）。
  // 所以重置时刻之前一律不跑，等当天真正的排班。
  const resetHour = Number(game.dailyResetHour ?? 4);
  const nowHour = new Date().getHours();
  if (nowHour < resetHour) {
    const note = `还没到今天的日常周期（凌晨 ${resetHour}:00 重置），本轮不跑，等当天正常的排班。`;
    log(stateDir, `skipped before reset: ${note}`);
    notify({ stateDir, title: `${game.title} 日常：未执行`, body: note });
    process.exit(0);
  }

  const pluginState = readPluginState(stateDir);
  const guard = !pluginState.ui || pluginState.ui.foregroundGuard !== false;
  const gameState = pluginState.games && pluginState.games[args.game] ? pluginState.games[args.game] : {};
  const timeoutMin = Number.isFinite(Number(gameState.timeoutMin)) ? Number(gameState.timeoutMin) : args.timeoutMin;
  log(stateDir, `foreground guard=${guard ? 'on' : 'off'} timeoutMin=${timeoutMin}`);
  const started = await startRun({
    gameId: args.game,
    mode: args.mode,
    stateDir,
    profile: args.profile,
    trigger: 'schedule',
    skillsRoot: args.skillsRoot || defaultSkillsRoot(),
    timeoutMin,
    guard,
  });
  if (!started.ok) {
    log(stateDir, `start failed: ${started.error}`);
    process.exit(1);
  }
  log(stateDir, `headless spawned pid=${started.pid} runId=${started.runId}`);

  // 幂等跳过：今天已经做过了（或缺口需要人工补），别弹「已完成」的假通知。
  if (started.skipped) {
    const skipReport = readReport(stateDir, args.game, started.runId) || {};
    const gaps = (skipReport.steps || []).map((s) => s.detail || '').filter(Boolean).join('、');
    notify({
      stateDir,
      title: `${game.title} 日常：已跳过`,
      body: gaps ? `今天已经跑过，但还差：${gaps}` : '今天已经跑过，本次没有重复拉起游戏。',
    });
    log(stateDir, `skipped: ${skipReport.notes || ''}`);
    process.exit(0);
  }

  // 看门狗预算：比计划任务的执行时限少 5 分钟。到点由插件自己收尾（停 headless、
  // 写兜底报告），而不是等 Windows 把整个进程树杀掉——那样连报告都不会留下。
  const budgetMin = Math.max(5, Math.round(timeoutMin) - 5);
  const deadline = Date.now() + budgetMin * 60 * 1000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  while (Date.now() < deadline) {
    await sleep(5000);
    if (!isRunning(stateDir, args.game)) break;
  }
  if (isRunning(stateDir, args.game)) {
    log(stateDir, `watchdog: ${budgetMin}min budget reached (timeoutMin=${timeoutMin}), stopping run`);
    try {
      stopRun({ stateDir, gameId: args.game });
    } catch (error) {
      log(stateDir, `watchdog: stopRun failed: ${String((error && error.message) || error)}`);
    }
    const stopDeadline = Date.now() + 60 * 1000;
    while (isRunning(stateDir, args.game) && Date.now() < stopDeadline) await sleep(2000);
    if (!readReport(stateDir, args.game, started.runId)) {
      try {
        writeJson(reportPathOf(stateDir, args.game, started.runId), {
          schemaVersion: 1,
          status: 'timeout',
          mode: args.mode,
          runId: started.runId,
          game: args.game,
          startedAt: new Date(Date.now() - budgetMin * 60 * 1000).toISOString(),
          endedAt: new Date().toISOString(),
          steps: [],
          evidence: [`watchdog=${budgetMin}min`, `timeoutMin=${timeoutMin}`],
          notes: `超过看门狗预算 ${budgetMin} 分钟，插件主动停止；未拿到 headless 报告。可调大排班超时，或检查是否有窗口频繁抢焦点导致反复暂停。`,
          generatedBy: 'run-headless-watchdog',
        });
      } catch {
        /* ignore */
      }
    }
    log(stateDir, `watchdog: stopped after ${budgetMin}min, report written`);
    notify({
      stateDir,
      title: `${game.title} 日常：超时`,
      body: `超过 ${budgetMin} 分钟被看门狗中止，请看 automation/run-headless.log。`,
    });
    process.exit(3);
  }
  const report = readReport(stateDir, args.game, started.runId);
  const reportFile = reportPathOf(stateDir, args.game, started.runId);
  if (!report) {
    log(stateDir, `no report at ${reportFile} (run dir ${runDirOf(stateDir, args.game, started.runId)})`);
    // 没有报告 = 出了没预料到的问题，也得让人知道。
    notify({
      stateDir,
      title: `${game.title} 日常：失败`,
      body: '运行结束但没有产出报告，请查看 automation/run-headless.log。',
    });
    process.exit(1);
  }
  log(stateDir, `report status=${report.status || 'unknown'} file=${reportFile}`);

  // 通知不依赖 DSH 开着：计划任务跑完直接弹一条，
  // 否则「人不在电脑前、DSH 没启动」的那天就完全没人知道结果。
  const summary = dailySummary(stateDir, args.game, { resetHour: game.dailyResetHour });
  const status = report.status || 'unknown';
  const statusText = { success: '已完成', partial: '部分完成', failed: '失败', timeout: '超时' }[status] || status;
  const doneText = summary.done.length ? `完成 ${summary.done.length} 项` : '';
  const gapText = summary.gaps.length ? `，还差：${summary.gaps.join('、')}` : '';
  notify({
    stateDir,
    title: `${game.title} 日常：${statusText}`,
    body: `${doneText}${gapText}`,
  });

  // 退出码区分：0=成功、1=失败、2=部分完成、3=超时。
  // 任务计划器里能一眼看出「今天只是没做完」，而不是和失败混在一起。
  if (status === 'failed') process.exit(1);
  if (status === 'partial') process.exit(2);
  if (status === 'timeout') process.exit(3);
  process.exit(0);
}

main().catch((error) => {
  try {
    console.error(error && error.stack ? error.stack : String(error));
  } catch {
    /* ignore */
  }
  process.exit(1);
});
