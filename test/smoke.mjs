// 冒烟测试：不碰游戏、不建计划任务，只验证模块能加载、纯函数与读操作正常。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GAMES, GAME_IDS, gameById, taskNameFor, isWeekdays } from '../lib/games.mjs';
import { defaultState, normalizeState, Store, summarizeRun, runStatusOf } from '../lib/state.mjs';
import { probeDependencies, resolveDsh } from '../lib/deps.mjs';
import { buildRunPrompt, buildInstallPrompt, buildReportPrompt } from '../lib/prompt.mjs';
import { newRunId, summaryOf, listRuns, writeJson, metaPathOf, reportPathOf } from '../lib/report.mjs';
import { queryTasks, taskStatus, refreshTaskInfo, readTaskDefinition, computeNextRun } from '../lib/tasks.mjs';
import { guardScriptPath, guardStatus } from '../lib/runner.mjs';
import { resolveBettergiMcp, vendorPath } from '../lib/bettergi-mcp.mjs';

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

check('games registry', () => {
  if (GAMES.length !== 4) throw new Error(`期望 4 个游戏，实际 ${GAMES.length}`);
  if (!GAME_IDS.includes('genshin')) throw new Error('缺 genshin');
  if (taskNameFor('game-daily-', 'hi') !== 'game-daily-hi') throw new Error('taskNameFor 不对');
  if (!isWeekdays([1, 3, 7]) || isWeekdays([0, 2]) || isWeekdays([])) throw new Error('isWeekdays 判定不对');
  return GAMES.map((g) => `${g.id}:${g.engine}:${g.defaultTime}`).join(' ');
});

check('state normalize', () => {
  const bad = normalizeState({ ui: { lastGame: 'nope' }, games: { hi: { enabled: 'yes', timeoutMin: 999, schedule: { time: '25:99' } } } });
  if (bad.ui.lastGame !== 'genshin') throw new Error('非法 lastGame 未回落');
  if (bad.games.hi.enabled !== false) throw new Error('enabled 非 true 应视为 false');
  if (bad.games.hi.timeoutMin !== 180) throw new Error(`timeout 999 未夹到 180：${bad.games.hi.timeoutMin}`);
  const nan = normalizeState({ games: { hi: { timeoutMin: 'abc' } } });
  if (nan.games.hi.timeoutMin !== 90) throw new Error(`非数字 timeout 未回落 90：${nan.games.hi.timeoutMin}`);
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
    results[2].ok = true;
    results[2].detail = 'state.json 原子写 + 回读 ok';
  })
  .catch((error) => {
    if (results[2]) {
      results[2].ok = false;
      results[2].detail = String((error && error.stack) || error);
    }
  })
  .then(() => {
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
    for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  ${item.detail}`);
    exitCode = results.some((item) => !item.ok) ? 1 : 0;
    console.log(JSON.stringify({ ok: exitCode === 0, total: results.length, failed: results.filter((r) => !r.ok).length }));
    process.exit(exitCode);
  });
