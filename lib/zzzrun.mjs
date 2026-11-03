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
 * 今天已经做过的应用（读应用记录里的 dt）。
 *
 * 为什么需要：后端的应用记录是**按天**的，一轮跑完只有「这一轮动过的」应用会变。
 * 补跑一轮时（例如下午再跑一次），已经成功的应用不会变化 → 报告里就没有它们 →
 * 每日清单上空空如也，看着像什么都没做。
 * 所以这里把今天（dt=当天）的成功记录一并算进清单。
 */
export function zzzTodayAppRecords(root, date = new Date()) {
  const dir = path.join(root, APP_RECORD_DIR);
  const today = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
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
    try {
      const text = fs.readFileSync(file, 'utf8');
      const dt = /dt:\s*'?(\d{8})'?/.exec(text);
      if (!dt || dt[1] !== today) continue;
      const status = appRunStatus(file);
      const mtime = fs.statSync(file).mtimeMs;
      out.push({
        name: name.replace(/\.yml$/, ''),
        at: new Date(mtime).toISOString(),
        fingerprint: appFingerprint(file),
        ok: status === 1 || status === 0,
        status,
        statusText: APP_STATUS[status] || '未知',
      });
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * 一条龙里**启用**的应用（从 config/01/one_dragon/_group.yml 读）。
 *
 * 用来判断「今天该跑但没跑的应用」：
 * 2026-11-03 用户反馈「每日做完了但体力一点没清」——
 * 根源是「体力计划」这个应用默认是关着的，做完每日活跃度就下线了。
 * 现在把体力计划打开了，清单就必须把它算进去：今天没跑 = 缺口，
 * 否则面板上全绿，人还以为体力也清了。
 */
export function enabledApps(root) {
  try {
    const file = path.join(root, 'config', '01', 'one_dragon', '_group.yml');
    const text = fs.readFileSync(file, 'utf8');
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^\s*-\s*app_id:\s*(\S+)/.exec(lines[i]);
      if (!m) continue;
      const id = m[1].replace(/^["']|["']$/g, '');
      // enabled 写在下一两行
      let enabled = true;
      for (let k = i + 1; k < Math.min(i + 4, lines.length); k += 1) {
        if (/^\s*-\s*app_id:/.test(lines[k])) break;
        const e = /enabled:\s*(true|false)/.exec(lines[k]);
        if (e) {
          enabled = e[1] === 'true';
          break;
        }
      }
      if (enabled) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 上游已知跑不通的应用（不算每日缺口）。
 *
 * 2026-11-02 连续三轮实测（19:57 / 21:24 / 21:57）都稳定失败，且都不是「每日没做完」：
 *   · notify        —— 「通知服务:应用运行结果通知发送(非玩法,无消耗)」，本来就不是玩法
 *   · life_on_line  —— 上游自己标了「即将移除请转插件」，功能已经搬到别的插件
 *   · intel_board   —— 委托板代行要清板面/打委托，失败不影响活跃度（活跃度已满时纯白跑）
 *
 * 配置放在一条龙根目录的 config/zzz-known-broken-apps.json（没有就用这份内置的）。
 */
export function knownBrokenApps(root) {
  const fallback = ['notify', 'life_on_line', 'intel_board'];
  try {
    const file = path.join(root, 'config', 'zzz-known-broken-apps.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) return raw.map((x) => String(x));
    if (Array.isArray(raw && raw.apps)) return raw.apps.map((x) => String(x));
  } catch {
    /* 用内置清单 */
  }
  return fallback;
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
  // 补上今天已经做过的（补跑时它们不会变化，但清单上应该看得到）。
  const collected = new Set(apps.map((item) => item.name));
  for (const item of zzzTodayAppRecords(root)) {
    if (collected.has(item.name)) continue;
    collected.add(item.name);
    apps.push({ ...item, detail: '今日已完成' });
  }
  const steps = apps.map((item) => ({
    name: item.name,
    ok: item.ok !== false,
    detail: `${item.detail ? `${item.detail} · ` : ''}${item.statusText || '成功'}${item.at ? ` · ${item.at}` : ''}`,
  }));
  const failedApps = apps.filter((item) => item.ok === false).map((item) => item.name);
  const failedNode = status.failed_node || '';
  // 上游已知跑不通的应用（2026-11-02 实测，连跑三轮都一样）：
  //   · notify        —— 「通知服务:应用运行结果通知发送(非玩法,无消耗)」，本来就不是玩法每日
  //   · life_on_line  —— 上游自己标了「即将移除请转插件」，功能在别的插件里
  //   · intel_board   —— 委托板的「代行」需要清板面，失败不影响活跃度（活跃度已满时更是白跑）
  // 这些失败不算「每日没做完」：否则面板上永远挂着这三个缺口，看着像没做。
  const known = knownBrokenApps(root);
  // 今天该跑却没跑的应用（配置里启用、但今天没有执行记录）也算缺口。
  const missing = enabledApps(root).filter(
    (name) => !collected.has(name) && !known.includes(name) && !failedApps.includes(name),
  );
  for (const name of missing) {
    steps.push({ name, ok: false, detail: '今日未执行' });
  }
  const knownFailed = failedApps.filter((name) => known.includes(name));
  const realFailed = failedApps.filter((name) => !known.includes(name)).concat(missing);
  const ok = status.state === 'success' && !failedNode && realFailed.length === 0;

  return {
    ok,
    status: ok ? 'success' : 'partial',
    steps,
    notes: [
      ok
        ? apps.length
          ? `一条龙全部结束，共 ${apps.length} 个应用执行${knownFailed.length ? `（其中 ${knownFailed.join('、')} 是上游已知跑不通的应用，不计入每日）` : ''}。`
          : '一条龙全部结束，但没有新的应用执行记录（今日日常此前已完成，或这些应用本轮判定为无需执行）。'
        : `一条龙结束状态=${status.state}${failedNode ? `，失败节点=${failedNode}` : ''}${failedApps.length ? `，失败的应用：${failedApps.join('、')}` : ''}${missing.length ? `，今天还没跑的应用：${missing.join('、')}` : ''}。`,
      knownFailed.length ? `已知的上游问题应用（不计入每日缺口）：${knownFailed.join('、')}` : '',
      '由 ZenlessZoneZero-OneDragon 后端执行（插件只负责调度与记账）。',
    ]
      .filter(Boolean)
      .join('\n'),
    evidence: [
      `state=${status.state}`,
      `last_status=${status.last_status || ''}`,
      `duration=${Math.round(Number(status.duration_seconds) || 0)}s`,
      `apps=${apps.length}`,
      `failedApps=${failedApps.length}`,
      `knownFailed=${knownFailed.join(',')}`,
    ],
    startedAt: new Date(startedAt).toISOString(),
  };
}
