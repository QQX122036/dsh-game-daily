// 绝区零：直连一条龙后端（HTTP），不再让 headless agent 用 zzz-od MCP 去转述。
//
// 后端本身就提供完整 API（/game/run/one-dragon、/game/status …），
// 插件只需要：确保后端在跑 → 下发一条龙 → 轮询状态 → 写报告。
import fs from 'node:fs';
import path from 'node:path';

const APP_RECORD_DIR = 'config/01/app_run_record';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url, timeoutMs = 15000, method = 'GET') {
  const response = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${method} ${url} → HTTP ${response.status}`);
  return response.json();
}

/** 本轮哪些应用真的跑了：对比 app_run_record 的修改时间。 */
export function collectZzzAppRecords(root, sinceMs) {
  const dir = path.join(root, APP_RECORD_DIR);
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of files) {
    if (!name.endsWith('.yml')) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    if (mtime >= sinceMs) out.push({ name: name.replace(/\.yml$/, ''), at: new Date(mtime).toISOString() });
  }
  return out;
}

/**
 * 跑一轮一条龙：下发 → 轮询 → 汇总。
 * 返回 { ok, status, steps, notes, evidence }，由调用方写 report.json。
 */
export async function runZzzOneDragon({ baseUrl, root, timeoutMs = 45 * 60 * 1000, pollMs = 5000 }) {
  const startedAt = Date.now();
  const before = new Set(collectZzzAppRecords(root, 0).map((item) => item.name));
  let started = null;
  try {
    started = await getJson(`${baseUrl}/game/run/one-dragon?block=false`, 60000, 'POST');
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      steps: [],
      notes: `一条龙下发失败：${String((error && error.message) || error)}`,
      evidence: [`started=false`],
    };
  }

  const deadline = startedAt + timeoutMs;
  let status = null;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    try {
      status = await getJson(`${baseUrl}/game/status`, 15000);
    } catch {
      continue;
    }
    if (status && status.state !== 'running') break;
  }

  if (!status || status.state === 'running') {
    return {
      ok: false,
      status: 'timeout',
      steps: [],
      notes: `一条龙超过 ${Math.round(timeoutMs / 60000)} 分钟仍未收尾，已放弃等待。`,
      evidence: [`timeout`],
    };
  }

  const apps = collectZzzAppRecords(root, startedAt).filter((item) => !before.has(item.name));
  const steps = apps.map((item) => ({ name: item.name, ok: true, detail: item.at }));
  const failedNode = status.failed_node || '';
  const ok = status.state === 'success' && !failedNode;

  return {
    ok,
    status: ok ? 'success' : 'partial',
    steps,
    notes: [
      ok
        ? apps.length
          ? `一条龙全部结束，共 ${apps.length} 个应用执行。`
          : '一条龙全部结束，但没有新的应用执行记录（今日日常此前已完成，或这些应用本轮判定为无需执行）。'
        : `一条龙结束状态=${status.state}${failedNode ? `，失败节点=${failedNode}` : ''}。`,
      '由 ZenlessZoneZero-OneDragon 后端执行（插件只负责调度与记账）。',
    ].join('\n'),
    evidence: [
      `state=${status.state}`,
      `last_status=${status.last_status || ''}`,
      `duration=${Math.round(Number(status.duration_seconds) || 0)}s`,
      `apps=${apps.length}`,
    ],
    startedAt: new Date(startedAt).toISOString(),
  };
}
