// 冒烟测试：不碰游戏、不建计划任务，只验证模块能加载、纯函数与读操作正常。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GAMES, GAME_IDS, gameById, taskNameFor, isWeekdays } from '../lib/games.mjs';
import { defaultState, defaultGameState, normalizeState, Store, summarizeRun, runStatusOf } from '../lib/state.mjs';
import { probeDependencies, resolveDsh } from '../lib/deps.mjs';
import { buildRunPrompt, buildInstallPrompt, buildReportPrompt } from '../lib/prompt.mjs';
import { newRunId, summaryOf, listRuns, writeJson, metaPathOf, reportPathOf } from '../lib/report.mjs';
import { queryTasks, taskStatus, refreshTaskInfo, readTaskDefinition, computeNextRun } from '../lib/tasks.mjs';
import { guardScriptPath, guardStatus, aliveFromError, readRunner } from '../lib/runner.mjs';
import { resolveBettergiMcp, vendorPath, bundledPath } from '../lib/bettergi-mcp.mjs';
import { SKILL_REPOS, inspectSkill, skillInstallPath, installSkill, bundledSkillPath } from '../lib/skills.mjs';
import { registerBettergiMcp, hasBettergiMcpRow, bettergiMcpPatchPath } from '../lib/mcp-register.mjs';
import { GAME_PROCESSES, runningGames, closeGame } from '../lib/gameproc.mjs';
import { inspectZzzInstall, zzzHealthSync, zzzBaseUrl, zzzInstallTargets, ensureZzzConfigs, detectZzzGamePath, inspectZzzInstallRoot } from '../lib/zzz.mjs';
import { compareVersions, readLocalVersion, readPackage } from '../lib/update.mjs';
import { parseM7aLog, m7aReport, resolveM7a, ensurePowerPlan } from '../lib/m7a.mjs';
import { parseBettergiLog, bettergiReport, resolveBettergi } from '../lib/bettergi.mjs';
import { businessDay, businessDayOfRunId, isPreviousCycle, DEFAULT_RESET_HOUR } from '../lib/dailycycle.mjs';
import { mergeReport, readDaily, dailySummary, dailyDecision } from '../lib/daily-state.mjs';
import { todayRunStatus, acquireRunLock } from '../lib/runner.mjs';
import { zzzAppSnapshot, collectZzzAppRecords, appFingerprint } from '../lib/zzzrun.mjs';

const results = [];
// 后台刷新一次任务信息，验证异步 PowerShell 路径（真实环境里这一步由请求触发、不阻塞 UI）。
const refreshed = await refreshTaskInfo(['BetterGI 日常一条龙']).catch(() => false);
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: String((error && error.stack) || error) });
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: String((error && error.stack) || error) });
  }
}

check('games registry', () => {
  if (GAMES.length !== 4) throw new Error(`期望 4 个游戏，实际 ${GAMES.length}`);
  if (!GAME_IDS.includes('genshin')) throw new Error('缺 genshin');
  if (taskNameFor('game-daily-', 'hi') !== 'game-daily-hi') throw new Error('taskNameFor 不对');
  if (!isWeekdays([1, 3, 7]) || isWeekdays([0, 2]) || isWeekdays([])) throw new Error('isWeekdays 判定不对');
  return GAMES.map((g) => `${g.id}:${g.engine}:${g.defaultTime}`).join(' ');
});

check('m7a log parse', () => {
  const okLog = [
    '+-----------------------------+',
    '|        开始领取奖励         |',
    '+-----------------------------+',
    '2026-10-27 23:01:43,466 | INFO | 当前界面：星际和平指南-每日实训',
    '2026-10-27 23:01:44,100 | INFO | 派遣委托或收取1次委托奖励: 已完成 +  (+100分)]',
    '2026-10-27 23:01:44,500 | INFO | 登录游戏: 已完成 +  (+100分)，当前分数: 200/500',
    '2026-10-27 23:01:45,000 | INFO | 累计消耗120点开拓力: 待完成',
    '2026-10-27 23:01:45,200 | INFO | 任务无法完成: 累计消灭20个敌人',
    '2026-10-27 23:01:46,000 | INFO | 邮件奖励已领取',
    '+-----------------------------+',
    '|          停止运行           |',
    '+-----------------------------+',
    '------------------------------------------------------- 完成 ---',
  ].join('\n');
  const okParsed = parseM7aLog(okLog, 0);
  if (okParsed.status !== 'partial') throw new Error(`有未完成任务应为 partial，实际 ${okParsed.status}`);
  // 阶段标题进 phases，不进 steps
  if (!okParsed.phases.includes('开始领取奖励')) throw new Error('没解析出阶段标题');
  const done = okParsed.steps.find((s) => s.name === '派遣委托或收取1次委托奖励');
  if (!done || done.ok !== true) throw new Error('没解析出已完成任务');
  const pending = okParsed.steps.find((s) => s.name === '累计消耗120点开拓力');
  if (!pending || pending.ok !== false) throw new Error('没解析出未完成任务');
  if (!okParsed.steps.some((s) => s.name === '邮件奖励' && s.ok)) throw new Error('没解析出已领取奖励');
  if (!okParsed.notes.includes('200/500')) throw new Error('没解析出活跃度分数');

  const failParsed = parseM7aLog('2026-10-27 23:00:00 | ERROR | 启动游戏失败', 1);
  if (failParsed.status !== 'failed') throw new Error(`非 0 退出应为 failed，实际 ${failParsed.status}`);

  const earlyExit = parseM7aLog('', 0);
  if (earlyExit.status !== 'partial') throw new Error(`无收尾标记应为 partial，实际 ${earlyExit.status}`);

  const report = m7aReport({ gameId: 'sr', mode: 'real', runId: 'x', exitCode: 0, startedAt: '', logText: okLog });
  if (report.generatedBy !== 'runner-m7a') throw new Error('m7aReport 字段不对');

  // 启动横幅也是 `| ... |` 形状，不能当成阶段。
  const bannerLog = [
    '|                          欢迎使用 March7th Assistant                          |',
    '|                 https://github.com/moesnow/March7thAssistant                 |',
    '|                  此程序为免费开源项目 如果你付了钱请立刻退款                  |',
    '|                                   开始日常任务                                 |',
  ].join('\n');
  const bannerParsed = parseM7aLog(bannerLog, 0);
  if (bannerParsed.phases.length !== 1 || bannerParsed.phases[0] !== '开始日常任务') {
    throw new Error(`横幅没被过滤：${JSON.stringify(bannerParsed.phases)}`);
  }
  return `partial=${okParsed.status} fail=${failParsed.status} early=${earlyExit.status} steps=${okParsed.steps.length} phases=${okParsed.phases.length}`;
});

check('bettergi log parse', () => {
  const log = [
    '[INF] 领取邮件：已完成',
    '[INF] 合成树脂：开始',
    '[INF] "自动秘境"：使用 "原粹树脂", 数量：40',
    '[INF] 自动秘境：开始奖励识别',
    '[INF] 体力耗尽或者设置轮次已达标，结束自动秘境',
    '[INF] 领取尘歌壶奖励:"洞天名称：罗浮洞"',
    '[WRN] 检查每日奖励结果："未领取"，请手动检查！',
    '[INF] 一条龙和配置组任务结束',
  ].join('\n');
  const parsed = parseBettergiLog(log, 0);
  if (parsed.status !== 'partial') throw new Error(`每日委托未完成应为 partial，实际 ${parsed.status}`);
  if (!parsed.steps.some((s) => s.name === '自动秘境')) throw new Error('没解析出自动秘境步骤');
  if (!parsed.notes.includes('每日委托')) throw new Error('没提示每日委托未完成');
  if (!/resin=40/.test(parsed.evidence.join(' '))) throw new Error(`树脂用量没统计：${parsed.evidence.join(' ')}`);
  const done = parseBettergiLog(log.replace('"未领取"', '"已领取"'), 0);
  if (done.status !== 'success') throw new Error(`全部完成应为 success，实际 ${done.status}`);
  // 领到了每日奖励，那一步才是 ok
  const reward = done.steps.find((s) => s.name === '每日奖励');
  if (!reward || reward.ok !== true) throw new Error('已领取时每日奖励应记为完成');
  // 没领到时不能记成完成（旧版会自相矛盾：步骤 ok:true + 备注说没领）
  const notClaimed = parsed.steps.find((s) => s.name === '每日奖励');
  if (!notClaimed || notClaimed.ok !== false) throw new Error('未领取时每日奖励应记为未完成');

  // 秘境 0 轮 = 没刷（树脂不够或今天已跑过），不能打勾
  const noResin = parseBettergiLog(
    ['[INF] "自动秘境"，用尽所有浓缩树脂和原粹树脂后结束', '[INF] 一条龙和配置组任务结束'].join('\n'),
    0,
  );
  const domain = noResin.steps.find((s) => s.name === '自动秘境');
  if (!domain || domain.ok !== false) throw new Error(`秘境 0 轮应记为未完成：${JSON.stringify(noResin.steps)}`);
  return `partial=${parsed.status} success=${done.status} steps=${parsed.steps.length}`;
});

check('daily cycle（4 点重置）', () => {
  if (DEFAULT_RESET_HOUR !== 4) throw new Error(`默认重置时刻应为 4 点：${DEFAULT_RESET_HOUR}`);
  // 22:40 属于当天；00:28 仍属于前一天
  if (businessDay(new Date(2026, 9, 31, 22, 40)) !== '20261031') {
    throw new Error(`22:40 应属 10-31：${businessDay(new Date(2026, 9, 31, 22, 40))}`);
  }
  if (businessDay(new Date(2026, 9, 31, 0, 28)) !== '20261030') {
    throw new Error(`00:28 应属 10-30：${businessDay(new Date(2026, 9, 31, 0, 28))}`);
  }
  // 跨月：11-01 00:28 仍属 10-31
  if (businessDay(new Date(2026, 10, 1, 0, 28)) !== '20261031') {
    throw new Error(`11-01 00:28 应属 10-31：${businessDay(new Date(2026, 10, 1, 0, 28))}`);
  }
  if (businessDayOfRunId('20261031-002805') !== '20261030') throw new Error('runId 00:28 归到错的天');
  if (businessDayOfRunId('20261031-223418') !== '20261031') throw new Error('runId 22:34 归到错的天');
  if (businessDayOfRunId('乱写的') !== '') throw new Error('非法 runId 应返回空串');
  if (isPreviousCycle('20261031-002805', 4, new Date(2026, 9, 31, 22, 40)) !== true) {
    throw new Error('00:28 那轮应判为上一周期');
  }
  if (isPreviousCycle('20261031-223418', 4, new Date(2026, 9, 31, 22, 40)) !== false) {
    throw new Error('22:34 那轮应判为当天');
  }
  return '00:28→前一天、22:34→当天，跨月正确';
});

check('幂等按业务日（跨天补跑不算今天）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-idem-'));
  try {
    // 0:28 的补跑（属于 10-30）成功
    writeJson(reportPathOf(dir, 'sr', '20261031-002805'), {
      schemaVersion: 1,
      status: 'success',
      mode: 'real',
      startedAt: '2026-10-30T16:28:05.802Z',
      endedAt: '2026-10-30T16:30:28.580Z',
      steps: [],
      generatedBy: 'runner-m7a',
    });
    // 幂等跳过产生的假报告（不该算数）
    writeJson(reportPathOf(dir, 'sr', '20261031-220735'), {
      schemaVersion: 1,
      status: 'success',
      mode: 'real',
      startedAt: '2026-10-31T14:07:35.063Z',
      endedAt: '2026-10-31T14:07:35.063Z',
      steps: [],
      generatedBy: 'runner-idempotent-skip',
    });
    const at = new Date(2026, 9, 31, 22, 40);
    const found = todayRunStatus(dir, 'sr', at, { resetHour: 4 });
    if (found) throw new Error(`0:28 的补跑与跳过报告都不该算今天：${JSON.stringify(found)}`);

    // 真正当天跑的一轮 → 应该被认出来
    writeJson(reportPathOf(dir, 'sr', '20261031-223418'), {
      schemaVersion: 1,
      status: 'success',
      mode: 'real',
      startedAt: '2026-10-31T14:34:18.482Z',
      endedAt: '2026-10-31T14:40:00.000Z',
      steps: [],
      generatedBy: 'runner-m7a',
    });
    const hit = todayRunStatus(dir, 'sr', at, { resetHour: 4 });
    if (!hit || hit.runId !== '20261031-223418') throw new Error(`当天那轮没被认出来：${JSON.stringify(hit)}`);
    return '跨天补跑不算、跳过不算、当天真跑才算';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('zzz 应用记录按内容比对', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-zzzrec-'));
  try {
    const recDir = path.join(dir, 'config', '01', 'app_run_record');
    fs.mkdirSync(recDir, { recursive: true });
    const file = path.join(recDir, 'email.yml');
    fs.writeFileSync(file, "run_status: 2\ndt: '20261030'\nrun_time: 10-30 23:00\n", 'utf8');
    const before = zzzAppSnapshot(dir);
    if (before.email === undefined) throw new Error('快照没读到 email');
    // 模拟「今天又跑了一遍」：文件同名，但内容变了
    fs.writeFileSync(file, "run_status: 2\ndt: '20261031'\nrun_time: 10-31 22:10\n", 'utf8');
    const changed = collectZzzAppRecords(dir, Date.now() - 60000, before);
    if (!changed.some((item) => item.name === 'email')) {
      throw new Error(`内容变了却没算跑过：${JSON.stringify(changed)}`);
    }
    // 内容没变 → 不算跑过
    const same = collectZzzAppRecords(dir, Date.now() - 60000, zzzAppSnapshot(dir));
    if (same.length) throw new Error(`内容没变却被算成跑过：${JSON.stringify(same)}`);
    if (!appFingerprint(file).includes('20261031')) throw new Error('指纹没读到 dt');
    return '同名不同内容=真跑过，内容不变=没跑';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('m7a 活跃度已满 ≠ 失败', () => {
  const log = [
    '|            开始日常任务             |',
    '2026-10-31 00:30:07,126 | INFO | 检测到本日活跃度已满提示，跳过后续任务检测',
    '2026-10-31 00:30:09,250 | INFO | 未检测到每日实训奖励',
    '|            停止运行             |',
  ].join('\n');
  const parsed = parseM7aLog(log, 0);
  if (parsed.status !== 'success') throw new Error(`活跃度已满应为 success，实际 ${parsed.status}`);
  if (!parsed.notes.includes('活跃度已满')) throw new Error('没写明活跃度已满');
  if (!parsed.steps.some((s) => s.name === '活跃度')) throw new Error('没记活跃度步骤');
  const report = m7aReport({
    gameId: 'sr',
    mode: 'real',
    runId: '20261031-002805',
    exitCode: 0,
    startedAt: new Date(2026, 9, 31, 0, 28).toISOString(),
    logText: log,
    resetHour: 4,
  });
  if (!report.notes.includes('上一日的日常')) throw new Error(`跨天提示缺失：${report.notes}`);
  return `status=${parsed.status} 跨天提示 ok`;
});

check('m7a 体力计划自愈', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-plan-'));
  try {
    const file = path.join(dir, 'config.yaml');
    // 模拟 M7A 跑完后把计划删空的样子
    fs.writeFileSync(file, 'locales: zh_CN\npower_enable: true\npower_plan: []\npower_plan_keep: false # 注释\n', 'utf8');
    const m7a = { config: file, exe: path.join(dir, 'March7th Assistant.exe') };
    const first = ensurePowerPlan(m7a, [['侵蚀隧洞', '睿治之径', 3]]);
    if (!first.ok || first.changed !== true) throw new Error(`第一次应写入：${JSON.stringify(first)}`);
    const text = fs.readFileSync(file, 'utf8');
    if (!/power_plan: \[\["侵蚀隧洞","睿治之径",3\]\]/.test(text)) throw new Error(`计划没写进去：${text}`);
    if (!/^power_plan_keep: true/m.test(text)) throw new Error(`power_plan_keep 没打开：${text}`);
    // 幂等：再来一次不该再改
    const second = ensurePowerPlan(m7a, [['侵蚀隧洞', '睿治之径', 3]]);
    if (!second.ok || second.changed !== false) throw new Error(`重复调用不应再写：${JSON.stringify(second)}`);
    return '计划补回 + keep 打开 + 幂等 ok';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('运行互斥锁', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-lock-'));
  try {
    const first = acquireRunLock(dir, { waitMs: 0 });
    if (!first.ok) throw new Error(`第一次应拿到锁：${JSON.stringify(first)}`);
    // 第二个（同一进程持有）应拿不到
    const second = acquireRunLock(dir, { waitMs: 0 });
    if (second.ok) {
      second.release();
      first.release();
      throw new Error('同一时刻不该拿到第二把锁');
    }
    if (!second.error) throw new Error('拿不到锁时应给出原因');
    // 释放后可以再拿
    first.release();
    const third = acquireRunLock(dir, { waitMs: 0 });
    if (!third.ok) throw new Error(`释放后应能再拿：${JSON.stringify(third)}`);
    third.release();
    // 死进程留下的锁应被当作过期锁接管
    const lock = path.join(dir, 'automation', 'runner.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: new Date().toISOString() }), 'utf8');
    const fourth = acquireRunLock(dir, { waitMs: 0 });
    if (!fourth.ok) throw new Error(`过期锁应被接管：${JSON.stringify(fourth)}`);
    fourth.release();
    return '互斥 / 释放 / 过期锁接管 ok';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('每日检查点（完成 / 缺口 / 补跑判定）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-daily-'));
  try {
    // 第一轮：部分完成
    mergeReport(
      dir,
      'sr',
      {
        runId: '20261031-100000',
        status: 'partial',
        startedAt: new Date(2026, 9, 31, 10, 0).toISOString(),
        steps: [
          { name: '登录游戏', ok: true, detail: '' },
          { name: '累计消耗120点开拓力', ok: false, detail: '本次未完成' },
        ],
      },
      {},
      { resetHour: 4 },
    );
    const s1 = dailySummary(dir, 'sr', { resetHour: 4 });
    if (s1.status !== 'partial') throw new Error(`状态应为 partial：${s1.status}`);
    if (!s1.done.includes('登录游戏')) throw new Error('做好的没记上');
    if (!s1.gaps.includes('累计消耗120点开拓力')) throw new Error('缺口没记上');
    if (s1.complete) throw new Error('有缺口不应算完成');

    // 允许补跑的游戏：有缺口 → 不跳过
    const d1 = dailyDecision(dir, 'sr', { resetHour: 4, autoRetry: 2 });
    if (d1.skip) throw new Error(`有缺口时不该跳过：${JSON.stringify(d1)}`);

    // 第二轮：补齐 → success
    mergeReport(
      dir,
      'sr',
      {
        runId: '20261031-110000',
        status: 'success',
        startedAt: new Date(2026, 9, 31, 11, 0).toISOString(),
        steps: [
          { name: '登录游戏', ok: true, detail: '' },
          { name: '累计消耗120点开拓力', ok: true, detail: '已完成 +200分' },
        ],
      },
      {},
      { resetHour: 4 },
    );
    const s2 = dailySummary(dir, 'sr', { resetHour: 4 });
    if (s2.status !== 'success') throw new Error(`补齐后应为 success：${s2.status}`);
    if (s2.gaps.length) throw new Error(`补齐后不该还有缺口：${s2.gaps.join('、')}`);
    if (!s2.complete) throw new Error('补齐后应算完成');
    const d2 = dailyDecision(dir, 'sr', { resetHour: 4, autoRetry: 2 });
    if (!d2.skip) throw new Error('完成之后应跳过');

    // 不允许补跑的游戏（autoRetry=0）：有缺口也跳过，但要说清差什么
    mergeReport(
      dir,
      'genshin',
      {
        runId: '20261031-120000',
        status: 'partial',
        startedAt: new Date(2026, 9, 31, 12, 0).toISOString(),
        steps: [{ name: '每日奖励', ok: false, detail: '每日委托未完成' }],
      },
      {},
      { resetHour: 4 },
    );
    const d3 = dailyDecision(dir, 'genshin', { resetHour: 4, autoRetry: 0 });
    if (!d3.skip) throw new Error('autoRetry=0 时应跳过');
    if (!d3.gaps.includes('每日奖励')) throw new Error('跳过时也要说清缺口');

    // 历史报告按它自己的开始时间归档，不会算到今天。
    // 注意：10-31 00:30 起的这一轮，业务日仍是 10-30（凌晨 4 点才重置）。
    mergeReport(
      dir,
      'sr',
      {
        runId: '20261031-003000',
        status: 'success',
        startedAt: new Date(2026, 9, 31, 0, 30).toISOString(),
        steps: [{ name: '跨天补跑的那一项', ok: true, detail: '' }],
      },
      {},
      { resetHour: 4 },
    );
    const old = readDaily(dir, 'sr', '20261030', 4);
    if (!old.done || !old.done['跨天补跑的那一项']) throw new Error('0:30 的那轮应归到 10-30');
    const today = readDaily(dir, 'sr', '20261031', 4);
    if (today.done['跨天补跑的那一项']) throw new Error('0:30 的那轮不该算进 10-31');
    if (!today.done['登录游戏']) throw new Error('今天的清单丢了');
    return `合并/缺口/补跑判定 ok（${s2.done.length} 项完成、${s2.gaps.length} 个缺口）`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('state normalize', () => {  const bad = normalizeState({ ui: { lastGame: 'nope' }, games: { hi: { enabled: 'yes', timeoutMin: 999, schedule: { time: '25:99' } } } });
  if (bad.ui.lastGame !== 'genshin') throw new Error('非法 lastGame 未回落');
  if (bad.games.hi.enabled !== false) throw new Error('enabled 非 true 应视为 false');
  if (bad.games.hi.timeoutMin !== 180) throw new Error(`timeout 999 未夹到 180：${bad.games.hi.timeoutMin}`);
  const nan = normalizeState({ games: { hi: { timeoutMin: 'abc' } } });
  const hiDefault = defaultGameState(GAMES.find((g) => g.id === 'hi')).timeoutMin;
  if (nan.games.hi.timeoutMin !== hiDefault) {
    throw new Error(`非数字 timeout 未回落到该游戏默认值 ${hiDefault}：${nan.games.hi.timeoutMin}`);
  }
  const genDefault = defaultGameState(GAMES.find((g) => g.id === 'genshin')).timeoutMin;
  if (genDefault !== 150) throw new Error(`原神默认超时应为 150：${genDefault}`);
  if (bad.games.hi.schedule.time !== '10:00') throw new Error(`非法时间未回落默认：${bad.games.hi.schedule.time}`);
  const good = normalizeState({ games: { sr: { enabled: true, timeoutMin: 200, schedule: { time: '07:30', weekdays: [6, 7], catchUp: false } } } });
  if (good.games.sr.timeoutMin !== 180) throw new Error('timeout 未夹到 180');
  if (!isWeekdays(good.games.sr.schedule.weekdays)) throw new Error('weekdays 丢失');
  if (good.games.sr.schedule.catchUp !== false) throw new Error('catchUp 丢失');
  return 'fallbacks + clamps ok';
});

results.push({ name: 'store roundtrip', ok: false, detail: 'pending' });

check('report helpers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-report-'));
  const runId = newRunId(new Date('2026-10-24T01:23:45'));
  if (runId !== '20261024-012345') throw new Error(`runId 格式错：${runId}`);
  const report = { schemaVersion: 1, status: 'partial', mode: 'real', startedAt: 't0', endedAt: 't1', steps: [{ id: '1', name: 'a', ok: true }, { id: '2', name: 'b', ok: false }], notes: 'note' };
  writeJson(reportPathOf(dir, 'hi', runId), report);
  writeJson(metaPathOf(dir, 'hi', runId), { runId, trigger: 'schedule', mode: 'real', startedAt: 't0' });
  const runs = listRuns(dir, 'hi');
  if (runs.length !== 1 || !runs[0].hasReport) throw new Error('listRuns 未识别报告');
  const summary = summaryOf(report);
  if (summary.steps.ok !== 1 || summary.steps.total !== 2) throw new Error('summary 统计错');
  if (runStatusOf('weird') !== 'unknown') throw new Error('runStatusOf 应回落 unknown');
  const sum2 = summarizeRun(runId, { trigger: 'schedule', mode: 'real' }, { status: 'success' });
  if (sum2.status !== 'success' || sum2.trigger !== 'schedule') throw new Error('summarizeRun 错');
  fs.rmSync(dir, { recursive: true, force: true });
  return `${runId} report/list/summary ok`;
});

check('prompt builders', () => {
  const game = gameById('genshin');
  const p = buildRunPrompt({ game, mode: 'dry', runId: 'x', runDir: 'C:\\tmp\\x', reportPath: 'C:\\tmp\\x\\report.json', skillsRoot: 'C:\\skills', stateDir: 'C:\\state' });
  if (!p.includes('演练') || !p.includes('report.json')) throw new Error('run prompt 缺关键内容');
  if (p.length > 12000) throw new Error(`prompt 太长：${p.length}`);
  const g2 = buildInstallPrompt({ action: 'fix-headless-credentials', gameId: 'genshin', checkId: 'headless', checkDetail: '缺少 credentials' });
  if (!g2.includes('headless')) throw new Error('install prompt 缺上下文');
  const r = buildReportPrompt({ game, runId: 'x', report: { status: 'success', steps: [{ id: '1', name: '登录', ok: true }] }, reportPath: 'p' });
  if (!r.includes('登录')) throw new Error('report prompt 缺步骤');
  return `run=${p.length} install=${g2.length} report=${r.length}`;
});

let exitCode = 0;
Promise.resolve()
  .then(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-store-'));
    const store = new Store({ dir, taskPrefix: 'game-daily-test-' });
    await store.load();
    store.mutate((state) => {
      state.games.hi.enabled = true;
      state.games.hi.schedule.time = '06:15';
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = new Store({ dir, taskPrefix: 'game-daily-test-' });
    await again.load();
    if (again.get().games.hi.schedule.time !== '06:15') throw new Error('state 未持久化');
    again.recordRun('hi', { runId: 'r1', trigger: 'manual', mode: 'real', status: 'success', startedAt: '2026-10-24T01:00:00Z', endedAt: '2026-10-24T01:10:00Z' });
    if (again.get().runs.hi.length !== 1) throw new Error('recordRun 未写入');
    fs.rmSync(dir, { recursive: true, force: true });
    const slot = results.find((r) => r.name === 'store roundtrip');
    if (slot) {
      slot.ok = true;
      slot.detail = 'state.json 原子写 + 回读 ok';
    }
  })
  .catch((error) => {
    const slot = results.find((r) => r.name === 'store roundtrip');
    if (slot) {
      slot.ok = false;
      slot.detail = String((error && error.stack) || error);
    }
  })
  .then(async () => {
    check('dsh resolve', () => {
      const dsh = resolveDsh();
      if (!dsh) throw new Error('找不到 dsh CLI');
      return `${dsh.kind} ${dsh.bin}`;
    });
    check('dependencies probe', () => {
      const probe = probeDependencies(['hi', 'sr']);
      if (!Array.isArray(probe.checks) || probe.checks.length < 5) throw new Error('体检项太少');
      for (const item of probe.checks) {
        if (!item.id || !item.label || !item.status) throw new Error(`体检项字段缺失：${JSON.stringify(item)}`);
      }
      const blockers = probe.checks.filter((c) => c.blocker).length;
      return `checks=${probe.checks.length} blockers=${blockers} ok=${probe.summary.ok}`;
    });
    check('scheduled task query', () => {
      const def = readTaskDefinition('BetterGI 日常一条龙');
      if (def.exists) {
        if (def.trigger && def.trigger.kind !== 'daily') throw new Error(`应为 daily 触发器：${JSON.stringify(def.trigger)}`);
        if (def.runLevel && def.runLevel !== 'HighestAvailable') throw new Error(`RunLevel 异常：${def.runLevel}`);
        if (def.command && !/powershell\.exe/i.test(def.command)) throw new Error(`命令异常：${def.command}`);
      }
      const next = computeNextRun({ time: '10:00', weekdays: [1, 3] }, new Date('2026-10-24T08:00:00+08:00'));
      if (!next) throw new Error('computeNextRun 未算出下次运行');
      const plain = taskStatus('绝对不存在的任务-gd-smoke');
      if (plain.exists !== false) throw new Error('不存在的任务应 exists=false');
      const row = taskStatus('BetterGI 日常一条龙');
      return row.exists ? `BetterGI 日常一条龙: ${row.state} next=${row.nextRunTime || '(后台刷新中)'}` : '未安装该任务（可接受）';
    });
    check('foreground guard asset', () => {
      const script = guardScriptPath();
      if (!fs.existsSync(script)) throw new Error(`缺前台守护脚本：${script}`);
      const head = fs.readFileSync(script).subarray(0, 3);
      if (!(head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf)) {
        throw new Error('keep-foreground.ps1 缺 BOM（PS 5.1 中文会乱码）');
      }
      const state = guardStatus('genshin');
      if (state.running) throw new Error('冒烟测试期间不该有守护进程');
      return 'keep-foreground.ps1 就绪（BOM ok）';
    });
    check('runner alive 判定（EPERM 视为存活）', () => {
      // 回归：Windows 上 Medium 宿主探测提权进程只会拿到 EPERM，
      // 早先被当成「进程不存在」，导致计划任务轮次被 reconcile 在 +3 分钟误判 failed。
      const eperm = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      const esrch = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      if (aliveFromError(eperm) !== true) throw new Error('EPERM 必须视为进程仍存活');
      if (aliveFromError(esrch) !== false) throw new Error('ESRCH 应视为进程不存在');
      if (aliveFromError(null) !== false) throw new Error('空错误应为假');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-alive-'));
      try {
        fs.mkdirSync(path.join(dir, 'automation'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'automation', 'runner-probe.pid'), JSON.stringify({ pid: process.pid }), 'utf8');
        const self = readRunner(dir, 'probe');
        if (!self || self.running !== true) throw new Error('当前进程应判为存活');
        if (readRunner(dir, 'nope') !== null) throw new Error('没有 pid 文件时应返回 null');
        return `EPERM→存活、ESRCH→不存在；本进程 pid=${process.pid} 判为 running`;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    check('zzz one-dragon integration', () => {
      const zzz = gameById('zzz');
      if (!zzz) throw new Error('缺少绝区零注册项');
      if (zzz.engine !== 'zzz-direct') throw new Error(`绝区零引擎应为 zzz-direct（直连一条龙后端）：${zzz.engine}`);
      if (zzz.canRun !== true) throw new Error('绝区零应当可以运行');
      if (!zzz.defaultTime) throw new Error('绝区零缺少默认时间');
      const realMcp = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'tools', 'zzz-od-mcp', 'zzz-od-mcp.mjs');
      if (!fs.existsSync(realMcp)) throw new Error(`缺 zzz-od-mcp 脚本：${realMcp}`);
      const text = fs.readFileSync(realMcp, 'utf8');
      for (const tool of ['zzz_run_one_dragon', 'zzz_enter', 'zzz_wait', 'zzz_server']) {
        if (!text.includes(`'${tool}'`) && !text.includes(`"${tool}"`)) throw new Error(`MCP 缺工具：${tool}`);
      }
      const serverPs = path.join(path.dirname(realMcp), '..', '..', 'automation', 'zzz-server.ps1');
      if (!fs.existsSync(serverPs)) throw new Error(`缺 zzz-server.ps1：${serverPs}`);
      const bytes = fs.readFileSync(serverPs);
      const nonAscii = bytes.filter((b) => b > 127).length;
      if (nonAscii > 0) throw new Error(`zzz-server.ps1 含 ${nonAscii} 个非 ASCII 字节（PS 5.1 会读坏）`);
      const info = inspectZzzInstall();
      if (typeof info.ok !== 'boolean' || !info.root) throw new Error('inspectZzzInstall 返回值异常');
      const health = zzzHealthSync({ timeoutMs: 1500 });
      if (typeof health.ok !== 'boolean') throw new Error('zzzHealthSync 返回值异常');
      return `zzz:${zzz.engine}:${zzz.defaultTime} mcp ok, server ps ascii ok, health=${health.ok ? 'up' : 'down'} (${zzzBaseUrl()})`;
    });
    check('game process helpers', () => {
      const keys = Object.keys(GAME_PROCESSES);
      if (keys.length !== 4) throw new Error(`进程映射应为 4 个游戏：${keys.join(',')}`);
      const running = runningGames();
      for (const id of keys) {
        if (typeof running[id] !== 'boolean') throw new Error(`runningGames().${id} 不是布尔`);
      }
      // 只对「确认没在运行」的游戏做一次空关闭，验证 taskkill 的成功判定逻辑。
      if (running.zzz === false) {
        const closed = closeGame('zzz');
        if (!closed || closed.ok !== true) throw new Error(`closeGame 空调用应成功：${JSON.stringify(closed)}`);
        if (Array.isArray(closed.closed) && closed.closed.length) throw new Error('没运行却报告关掉了进程');
      }
      return keys.map((id) => `${id}:${running[id] ? 'running' : 'idle'}`).join(' ');
    });
    await checkAsync('skill install helpers', async () => {
      const spec = SKILL_REPOS['bettergi-control'];
      if (!spec || !/^https:\/\/codeload\.github\.com\//.test(spec.zip)) throw new Error('缺少 bettergi-control 的 zip 地址');
      if (!spec.minScripts || spec.minScripts < 10) throw new Error('脚本数下限不合理');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-skill-'));
      try {
        const info = inspectSkill(root, 'bettergi-control');
        if (info.installed) throw new Error('空目录不应判定已安装');
        if (skillInstallPath(root, 'bettergi-control') !== info.dir) throw new Error('skillInstallPath 与 inspectSkill 不一致');
        const missing = await installSkill('bettergi-control', { root: '' });
        if (missing.ok !== false || !missing.error) throw new Error('缺 root 应返回错误');
        return `zip ok, inspect ok, guard ok`;
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    check('mcp register', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-home-'));
      try {
        const dir = path.join(home, 'profiles', 'test');
        fs.mkdirSync(dir, { recursive: true });
        const file = bettergiMcpPatchPath('test', home);
        fs.writeFileSync(file, '- insert: []\n', 'utf8');
        const fake = path.join(home, 'vendor', 'bettergi-mcp', 'bettergi-mcp.mjs');
        fs.mkdirSync(path.dirname(fake), { recursive: true });
        fs.writeFileSync(fake, '// stub\n', 'utf8');
        const first = registerBettergiMcp({ profile: 'test', scriptPath: fake, home });
        if (!first.ok || first.changed !== true) throw new Error(`首次注册应写入：${JSON.stringify(first)}`);
        const text = fs.readFileSync(file, 'utf8');
        if (!hasBettergiMcpRow(text)) throw new Error('写入后回读缺 bettergi MCP 行');
        if (!/serverName: bettergi/.test(text) || !/command: node/.test(text)) throw new Error('补丁内容不完整');
        if (first.backup && !fs.existsSync(first.backup)) throw new Error('缺少备份文件');
        const second = registerBettergiMcp({ profile: 'test', scriptPath: fake, home });
        if (!second.ok || second.changed !== false) throw new Error('重复注册不应再写');
        return 'patch append + idempotent + backup ok';
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
    check('task info refresh', () => {
      if (refreshed !== true) return '未刷新（无任务或 PowerShell 不可用，容忍）';
      const row = taskStatus('BetterGI 日常一条龙');
      if (row.exists && !row.nextRunTime && !row.lastRunTime) throw new Error('刷新后仍无下次/上次运行时间');
      return `next=${row.nextRunTime || '-'} last=${row.lastRunTime || '-'}`;
    });
    check('bettergi-mcp resolver', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-bgmcp-'));
      const vendor = vendorPath(tmp);
      if (!vendor.endsWith(path.join('vendor', 'bettergi-mcp', 'bettergi-mcp.mjs'))) throw new Error(`vendor 路径异常：${vendor}`);
      fs.mkdirSync(path.dirname(vendor), { recursive: true });
      fs.writeFileSync(vendor, '// smoke placeholder\n', 'utf8');
      const savedEnv = process.env.DSH_GAME_DAILY_BETTERGI_MCP;
      delete process.env.DSH_GAME_DAILY_BETTERGI_MCP;
      try {
        const hit = resolveBettergiMcp({ stateDir: tmp });
        if (hit !== vendor) throw new Error(`应命中 vendor，实际：${hit}`);
        const standalone = path.join(tmp, 'standalone.mjs');
        fs.writeFileSync(standalone, '// env placeholder\n', 'utf8');
        process.env.DSH_GAME_DAILY_BETTERGI_MCP = standalone;
        const fromEnv = resolveBettergiMcp({ stateDir: tmp });
        if (fromEnv !== standalone) throw new Error(`env 应优先，实际：${fromEnv}`);
      } finally {
        if (savedEnv === undefined) delete process.env.DSH_GAME_DAILY_BETTERGI_MCP;
        else process.env.DSH_GAME_DAILY_BETTERGI_MCP = savedEnv;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      return 'vendor 优先 / env 覆盖 ok';
    });
    check('zzz install helpers', () => {
      const targets = zzzInstallTargets();
      if (!targets.length) throw new Error('没有安装目标候选');
      const systemRoot = `${String(process.env.SystemDrive || 'C:').replace(/\\+$/, '')}\\`.toLowerCase();
      for (const dir of targets) {
        if (path.parse(path.resolve(dir)).root.toLowerCase() === systemRoot) throw new Error(`候选里出现了系统盘：${dir}`);
      }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-zzz-'));
      const savedGame = process.env.DSH_GAME_DAILY_ZZZ_GAME;
      try {
        if (inspectZzzInstallRoot(tmp).ok) throw new Error('空目录不应判定为已安装');
        const fakeGame = path.join(tmp, 'ZenlessZoneZero.exe');
        fs.writeFileSync(fakeGame, 'stub', 'utf8');
        process.env.DSH_GAME_DAILY_ZZZ_GAME = fakeGame;
        const cfg = ensureZzzConfigs(tmp);
        if (!fs.existsSync(path.join(cfg.dir, 'game.yml'))) throw new Error('缺少 game.yml');
        const account = fs.readFileSync(path.join(cfg.dir, 'game_account.yml'), 'utf8');
        if (!account.includes(fakeGame)) throw new Error('game_account.yml 没写入游戏路径');
        const detected = detectZzzGamePath(path.join(cfg.dir, 'game_account.yml'));
        if (detected !== fakeGame) throw new Error(`detectZzzGamePath 读不回：${detected}`);
        return `targets=${targets.length} config steps=${cfg.steps.length} ok`;
      } finally {
        if (savedGame === undefined) delete process.env.DSH_GAME_DAILY_ZZZ_GAME;
        else process.env.DSH_GAME_DAILY_ZZZ_GAME = savedGame;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
    check('manifest has no BOM', () => {
      // PowerShell 的 Set-Content -Encoding UTF8 会写 BOM；DSH 用 JSON.parse 读 bundle 清单，
      // 带 BOM 会让 bundle 变成 availability=missing、整插件不加载（设置页条目消失）。
      const file = new URL('../package.json', import.meta.url);
      const bytes = fs.readFileSync(file);
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error('package.json 带 UTF-8 BOM，DSH 会拒绝加载');
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (!manifest?.dsh?.bundle?.patch) throw new Error('package.json 缺 dsh.bundle.patch');
      return 'no BOM, bundle patch ' + manifest.dsh.bundle.patch;
    });    check('bettergi-mcp bundled', () => {
      const file = bundledPath();
      if (!fs.existsSync(file)) throw new Error(`插件没自带 bettergi-mcp：${file}`);
      const size = fs.statSync(file).size;
      if (size < 50000) throw new Error(`自带 bettergi-mcp 过小：${size} 字节`);
      const text = fs.readFileSync(file, 'utf8');
      for (const tool of ['bgi_status', 'bgi_run_one_dragon']) {
        if (!text.includes(`'${tool}'`) && !text.includes(`"${tool}"`)) throw new Error(`自带 MCP 缺工具：${tool}`);
      }
      const savedEnv = process.env.DSH_GAME_DAILY_BETTERGI_MCP;
      delete process.env.DSH_GAME_DAILY_BETTERGI_MCP;
      try {
        // 没有 stateDir / vendor 时，应直接命中插件自带副本（装好即用，不需要联网）。
        const resolved = resolveBettergiMcp({});
        if (resolved !== file) throw new Error(`无外部副本时应返回自带路径，实际：${resolved}`);
      } finally {
        if (savedEnv === undefined) delete process.env.DSH_GAME_DAILY_BETTERGI_MCP;
        else process.env.DSH_GAME_DAILY_BETTERGI_MCP = savedEnv;
      }
      return `${Math.round(size / 1024)} KB, bundled fallback ok`;
    });
    await checkAsync('bettergi-control bundled install', async () => {
      const dir = bundledSkillPath('bettergi-control');
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error(`插件没自带技能：${dir}`);
      const scripts = fs.readdirSync(path.join(dir, 'scripts')).filter((f) => /\.ps1$/i.test(f)).length;
      if (scripts < 15) throw new Error(`自带技能脚本不足：${scripts}`);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-skill-bundled-'));
      try {
        const info = await installSkill('bettergi-control', { root, source: 'bundled' });
        if (!info.ok) throw new Error(`本地安装失败：${info.error}`);
        if (info.source !== 'bundled') throw new Error(`应走自带副本：${info.source}`);
        if (!fs.existsSync(path.join(root, 'bettergi-control', 'SKILL.md'))) throw new Error('安装后缺 SKILL.md');
        const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-skill-remote-'));
        try {
          // source=remote 只做参数校验：不真的联网下载，避免 CI 依赖网络。
          if (!SKILL_REPOS['bettergi-control'].zip) throw new Error('缺远程 zip 地址');
        } finally {
          fs.rmSync(target, { recursive: true, force: true });
        }
        return `bundled scripts=${scripts} files=${info.files} -> temp root ok`;
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    await checkAsync('update helpers', async () => {
      const cases = [
        ['0.2.0', '0.2.0', 0],
        ['0.3.0', '0.2.0', 1],
        ['0.2.9', '0.2.10', -1],
        ['v0.3.0', '0.3.0', 0],
        ['0.3.0-beta.1', '0.3.0', -1],
        ['0.3.0', '0.3.0-beta.2', 1],
      ];
      for (const [a, b, expected] of cases) {
        const actual = compareVersions(a, b);
        if (actual !== expected) throw new Error(`compareVersions(${a}, ${b}) = ${actual}，应为 ${expected}`);
      }
      const pkg = readPackage();
      if (!/^\d+\.\d+\.\d+/.test(String(pkg.version || ''))) throw new Error(`package.json 版本不合法：${pkg.version}`);
      const local = readLocalVersion();
      if (local !== pkg.version) throw new Error(`本地版本读取不一致：${local} vs ${pkg.version}`);
      if (compareVersions('9.9.9', local) <= 0) throw new Error('远端更高版本应判定为有更新');
      return `local=${local}`;
    });
    for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  ${item.detail}`);
    exitCode = results.some((item) => !item.ok) ? 1 : 0;
    console.log(JSON.stringify({ ok: exitCode === 0, total: results.length, failed: results.filter((r) => !r.ok).length }));
    process.exit(exitCode);
  });
