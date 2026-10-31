// 每日周期（业务日）：米哈游的日常任务在**凌晨 4 点**重置，
// 所以「0 点到 4 点之间跑的那一轮」做的仍然是昨天的日常。
//
// 踩过的坑：机器晚上关机，第二天 0:28 开机触发补跑，M7A 跑完发现「活跃度已满」
// （因为做的还是 10-30 的内容），插件却按运行日期 10-31 记了一笔 success，
// 于是 10:31 的重跑和 10-31 10:30 的排班全被幂等挡掉——10-31 真正的日常一次都没做。
//
// 现在所有「今天跑过没有」的判断都改用业务日：runId → 业务日 → 与当前业务日比较。
import { pad2 } from './report.mjs';

/** 米哈游三款游戏的日常重置时刻（小时，本地时间）。 */
export const DEFAULT_RESET_HOUR = 4;

/**
 * 业务日键（YYYYMMDD）：把时间往前推 resetHour 小时，取那一天的日期。
 * 例（resetHour=4）：10-31 00:28 → 10-30；10-31 10:30 → 10-31。
 */
export function businessDay(date = new Date(), resetHour = DEFAULT_RESET_HOUR) {
  const shift = Math.max(0, Math.min(23, Number(resetHour) || 0));
  const d = new Date(date.getTime());
  d.setHours(d.getHours() - shift);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/**
 * 从 runId（本地时间，形如 20261031-002805）推出它属于哪个业务日。
 * 解析不出来就返回空串（调用方据此当作「不可判定」，不做幂等拦截）。
 */
export function businessDayOfRunId(runId, resetHour = DEFAULT_RESET_HOUR) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(String(runId || '').trim());
  if (!m) return '';
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  return businessDay(d, resetHour);
}

/** 这轮运行落在「昨天」的业务日里吗（= 跨过了凌晨重置点）。 */
export function isPreviousCycle(runId, resetHour = DEFAULT_RESET_HOUR, now = new Date()) {
  const key = businessDayOfRunId(runId, resetHour);
  if (!key) return false;
  return key !== businessDay(now, resetHour);
}
