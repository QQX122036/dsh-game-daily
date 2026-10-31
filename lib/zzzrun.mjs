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

/**
 * 应用记录的指纹：dt（哪一天）+ run_time（几点跑的）+ run_status。
 * 只比「文件存不存在」是不够的：记录文件昨天就存在，今天真跑了也是同一个文件名，
 * 必须看内容变了没有——否则一轮跑完 11 个应用也会报成 0 个。
 */
export function appFingerprint(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const pick = (key) => {
      const m = new RegExp(`${key}:\\s*'?([^'\\n]*)'?`).exec(text);
      return m ? m[1].trim() : '';
    };
    // run_time 只到分钟；同一分钟里跑两次检测不到变化，用亚秒级的 run_time_float。
    const float = /run_time_float:\s*([\d.]+)/.exec(text);
    return [pick('dt'), pick('run_time'), pick('run_status'), float ? float[1] : ''].join('|');
  } catch {
    return '';
  }
}

/** 一条龙的记录状态：0=等待 1=成功 2=失败 3=进行中。 */
const APP_STATUS = { 0: '等待', 1: '成功', 2: '失败', 3: '进行中' };

/** 读一条应用记录里的 run_status（失败的应用不能记成「已完成」）。 */
export function appRunStatus(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = /run_status:\s*(\d+)/.exec(text);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** 应用记录目录的全量指纹快照（name → fingerprint），用于「跑前/跑后」比对。 */
export function zzzAppSnapshot(root) {
  const dir = path.join(root, APP_RECORD_DIR);
  const out = {};
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of files) {
    if (!name.endsWith('.yml')) continue;
    out[name.replace(/\.yml$/, '')] = appFingerprint(path.join(dir, name));
  }
  return out;
}

/**
 * 本轮哪些应用真的跑了：
 * - 跑之前就存在的记录 → 指纹变了才算跑过；
 * - 跑之前不存在的记录 → 文件在这一轮里新建的才算跑过。
 */
export function collectZzzAppRecords(root, sinceMs, before = {}) {
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
    const file = path.join(dir, name);
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const key = name.replace(/\.yml$/, '');
    const fingerprint = appFingerprint(file);
    const existed = Object.prototype.hasOwnProperty.call(before, key);
    const changed = existed && before[key] !== fingerprint;
    const created = !existed && mtime >= sinceMs;
    if (changed || created) {
      const status = appRunStatus(file);
      out.push({
        name: key,
        at: new Date(mtime).toISOString(),
        fingerprint,
        // run_status=2 是失败（一条龙的应用跑挂了），不能当成「已完成」。
        ok: status === 1 || status === 0,
        status,
        statusText: APP_STATUS[status] || '未知',
      });
    }
  }
  return out;
}

/**
 * 跑一轮一条龙：下发 → 轮询 → 汇总。
 * 返回 { ok, status, steps, notes, evidence }，由调用方写 report.json。
 */
export async function runZzzOneDragon({ baseUrl, root, timeoutMs = 45 * 60 * 1000, pollMs = 5000 }) {
  const startedAt = Date.now();
  const before = zzzAppSnapshot(root);
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
  // 接口 HTTP 200 不代表真的开始了：后端已有运行时会返回 {started:false, error:...}。
  // 不判断的话就会去轮询**别人那一轮**的状态，把别人的运行算成自己的。
  if (!started || started.started !== true) {
    const why = (started && (started.error || started.message)) || '后端没有接受这次下发';
    return {
      ok: false,
      status: 'failed',
      steps: [],
      notes: `一条龙没有开始：${why}。`,
      evidence: ['started=false'],
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

  const apps = collectZzzAppRecords(root, startedAt, before);
  const steps = apps.map((item) => ({
    name: item.name,
    ok: item.ok !== false,
    detail: `${item.statusText || '成功'}${item.at ? ` · ${item.at}` : ''}`,
  }));
  const failedApps = apps.filter((item) => item.ok === false).map((item) => item.name);
  const failedNode = status.failed_node || '';
  const ok = status.state === 'success' && !failedNode && failedApps.length === 0;

  return {
    ok,
    status: ok ? 'success' : 'partial',
    steps,
    notes: [
      ok
        ? apps.length
          ? `一条龙全部结束，共 ${apps.length} 个应用执行。`
          : '一条龙全部结束，但没有新的应用执行记录（今日日常此前已完成，或这些应用本轮判定为无需执行）。'
        : `一条龙结束状态=${status.state}${failedNode ? `，失败节点=${failedNode}` : ''}${failedApps.length ? `，失败的应用：${failedApps.join('、')}` : ''}。`,
      '由 ZenlessZoneZero-OneDragon 后端执行（插件只负责调度与记账）。',
    ].join('\n'),
    evidence: [
      `state=${status.state}`,
      `last_status=${status.last_status || ''}`,
      `duration=${Math.round(Number(status.duration_seconds) || 0)}s`,
      `apps=${apps.length}`,
      `failedApps=${failedApps.length}`,
    ],
    startedAt: new Date(startedAt).toISOString(),
  };
}
