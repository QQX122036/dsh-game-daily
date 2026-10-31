// 每日检查点：每款游戏、每一天「哪些任务做完了、还差什么」的持久化记录。
//
// 为什么需要：以前插件只记「这一轮跑完了没」（state.json 里一条 status），
// 于是
//   · 面板看不出星铁到底刷了几项、哪一项没刷；
//   · 一轮 partial 就把当天后续的排班全挡掉了（幂等只认 status）；
//   · 跨天的补跑会把「昨天的活」记成「今天做完了」。
//
// 现在：每轮跑完把报告里的 steps 合并进当天的检查点，
// 「做完了什么 / 还差什么 / 跑过几轮」都落在磁盘上，排班与面板都读它。
import fs from 'node:fs';
import path from 'node:path';
import { businessDay, businessDayOfIso } from './dailycycle.mjs';

export const DAILY_SCHEMA_VERSION = 1;

/** 检查点文件：<stateDir>/daily/<gameId>.json（每个游戏一份，避免互相踩）。 */
export function dailyPath(stateDir, gameId) {
  return path.join(stateDir, 'daily', `${gameId}.json`);
}

function readDailyFile(stateDir, gameId) {
  try {
    const raw = JSON.parse(fs.readFileSync(dailyPath(stateDir, gameId), 'utf8'));
    if (raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object') return raw;
  } catch {
    /* ignore */
  }
  return { schemaVersion: DAILY_SCHEMA_VERSION, gameId, days: {} };
}

function writeDailyFile(stateDir, gameId, data) {
  const file = dailyPath(stateDir, gameId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 取某天的检查点。
 * @param {string} stateDir
 * @param {string} gameId
 * @param {string} [key] 业务日（YYYYMMDD）；不给就用「当前业务日」
 * @param {number} [resetHour] 日常重置时刻（凌晨 4 点）
 */
export function readDaily(stateDir, gameId, key = '', resetHour = 4) {
  const day = key || businessDay(new Date(), resetHour);
  const file = readDailyFile(stateDir, gameId);
  const entry = file.days[day] || null;
  return entry ? { day, ...entry } : { day, status: '', done: {}, gaps: {}, runs: [], updatedAt: '' };
}

/**
 * 把一轮运行的报告合并进检查点。
 *
 * 合并规则：
 *   · ok=true  → 记进 done，并从 gaps 里移除（后一次的成功覆盖前一次的失败）
 *   · ok=false → 记进 gaps（如果 done 里已经有同名成功项，就不动它）
 *   · status   → success/partial/failed 里「最差的那个」优先：failed > partial > success，
 *                但只要后续有一轮 success，就把当天判成 success。
 */
export function mergeReport(stateDir, gameId, report, meta = {}, { resetHour = 4, day = '' } = {}) {
  if (!report || typeof report !== 'object') return null;
  // 「幂等跳过」的报告没真跑游戏，不能进清单。
  if (report.generatedBy === 'runner-idempotent-skip') return null;
  // 归属哪一天，看**这轮跑的时候**是哪个业务日 —— 不能用「现在」，
  // 否则 DSH 关着时跑的历史报告会被算进今天。
  const key = day || businessDayOfIso(report.startedAt || meta.startedAt, resetHour) || businessDay(new Date(), resetHour);
  const file = readDailyFile(stateDir, gameId);
  const prev = file.days[key] || { status: '', done: {}, gaps: {}, runs: [], updatedAt: '' };
  const done = { ...(prev.done || {}) };
  const gaps = { ...(prev.gaps || {}) };
  const runs = Array.isArray(prev.runs) ? [...prev.runs] : [];
  const at = new Date().toISOString();
  const runId = report.runId || meta.runId || '';

  const steps = Array.isArray(report.steps) ? report.steps : [];
  // 引擎自己说「成功」时，以它的判断为准：此时的 ok=false 多半是
  // 「本地区拓展任务」这类不计入活跃度的条目（星铁的差分宇宙/合成机就是这种），
  // 当成缺口会让清单永远补不完。
  const trustFailures = report.status !== 'success';
  for (const step of steps) {
    if (!step || !step.name) continue;
    // 阶段标题不是「完成的任务」（否则清单里会出现「今天做完了 开始清体力」这种条目）。
    if (step.kind === 'phase' || step.detail === '阶段') continue;
    const name = String(step.name);
    if (step.ok === true) {
      done[name] = { ok: true, at, runId, detail: String(step.detail || '').slice(0, 160) };
      delete gaps[name];
    } else if (trustFailures) {
      if (!done[name]) {
        gaps[name] = { ok: false, at, runId, detail: String(step.detail || '').slice(0, 160) };
      }
    }
  }

  if (runId && !runs.includes(runId)) runs.push(runId);

  const status = report.status === 'success' ? 'success' : report.status === 'failed' ? 'failed' : 'partial';
  const prevStatus = prev.status === 'failed' ? 'failed' : prev.status === 'partial' ? 'partial' : prev.status;
  // 任何一轮 success 就把当天判成 success；否则保留更差的状态。
  const merged = status === 'success' ? 'success' : prevStatus === 'success' ? 'success' : status === 'failed' ? 'failed' : 'partial';

  file.schemaVersion = DAILY_SCHEMA_VERSION;
  file.gameId = gameId;
  file.days[key] = {
    status: merged,
    done,
    gaps,
    runs: runs.slice(-10),
    updatedAt: at,
    lastRunId: runId || prev.lastRunId || '',
  };
  // 只留最近 14 天，避免文件无限增长。
  const days = file.days;
  const keys = Object.keys(days).sort();
  while (keys.length > 14) delete days[keys.shift()];
  try {
    writeDailyFile(stateDir, gameId, file);
  } catch {
    /* ignore */
  }
  return file.days[key];
}

/** 检查点摘要：给面板 / 排班判断用。 */
export function dailySummary(stateDir, gameId, { key = '', resetHour = 4 } = {}) {
  const entry = readDaily(stateDir, gameId, key, resetHour);
  const done = Object.keys(entry.done || {});
  const gaps = Object.keys(entry.gaps || {});
  return {
    day: entry.day,
    status: entry.status || '',
    done,
    gaps,
    runs: entry.runs || [],
    lastRunId: entry.lastRunId || '',
    updatedAt: entry.updatedAt || '',
    complete: entry.status === 'success' && gaps.length === 0,
  };
}

/**
 * 当天是否还需要再跑。
 *
 * 规则（比旧的「今天跑过就跳过」精细）：
 *   · success 且没有缺口 → 不用再跑（幂等跳过）
 *   · partial/failed      → 还差东西，**允许补跑**（每个游戏每天最多 autoRetry 次）
 *   · 一次都没跑过        → 当然要跑
 *
 * @returns {{skip:boolean, reason:string, gaps:string[], retries:number}}
 */
export function dailyDecision(stateDir, gameId, { key = '', resetHour = 4, autoRetry = 2 } = {}) {
  const entry = readDaily(stateDir, gameId, key, resetHour);
  const gaps = Object.keys(entry.gaps || {});
  const runs = (entry.runs || []).length;
  if (!runs) return { skip: false, reason: '今天还没跑过', gaps, retries: runs };
  if (entry.status === 'success' && gaps.length === 0) {
    return { skip: true, reason: '今天已经完成', gaps, retries: runs };
  }
  if (runs >= Math.max(0, Number(autoRetry) || 0) + 1) {
    return {
      skip: true,
      reason: gaps.length
        ? `今天已经尝试 ${runs} 次，仍有缺口，不再自动重试`
        : `今天已经尝试 ${runs} 次，上一轮没成功，不再自动重试`,
      gaps,
      retries: runs,
    };
  }
  return {
    skip: false,
    reason: gaps.length ? `还差：${gaps.join('、')}` : '上一轮没成功，补跑一次',
    gaps,
    retries: runs,
  };
}
