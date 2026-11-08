/**
 * lib/m7a.mjs — 三月七小助手（March7thAssistant / M7A）的最小控制层。
 *
 * 用途：
 *   - 依赖体检：找到安装目录、读 m7a.exe --status、判断游戏路径与首次确认状态；
 *   - runner / prompt 里给出环境事实与运行入口（m7a.exe 的任务 id、退出码含义）；
 *   - 读运行记录 / 日志，供 agent 值守时判断成败与介入时机。
 *
 * 不在这里做任何游戏画面操作：识别与点击全部交给三月七小助手自己。
 * 唯一的外部契约来自 M7A 官方 agent skill（m7a.exe 命令行 + logs/runs 记录格式）。
 */

import { spawnSync } from 'node:child_process';
import fs, { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_DIR_DEFAULT = path.join(os.homedir(), '.dsh', 'game-daily');

/** 崩铁默认跑哪个 M7A 任务（可用环境变量覆盖；main = 完整运行 = 日常+清体力）。 */
export const DEFAULT_M7A_TASK = process.env.DSH_GAME_DAILY_SR_M7A_TASK || 'main';

/** 退出码 → 语义（M7A 官方约定）。 */
export const M7A_EXIT = {
  0: { status: 'success', label: '成功' },
  1: { status: 'failed', label: '任务失败' },
  2: { status: 'bad-args', label: '参数错误' },
  3: { status: 'first-run-required', label: '首次使用尚未确认（必须用户本人在图形界面确认免责声明）' },
  4: { status: 'busy', label: '已有任务在运行，本次未执行' },
  5: { status: 'no-uac', label: '没有获得管理员权限（UAC 被取消）' },
  6: { status: 'stopped', label: '任务被停止指令中止' },
};

export function exitMeaning(code) {
  return M7A_EXIT[code] || { status: 'unknown', label: `未知退出码 ${code}` };
}

export function stateDir() {
  return process.env.DSH_GAME_DAILY_STATE_DIR || STATE_DIR_DEFAULT;
}

/** 安装位置书签：安装/体检时把实际根目录写在这里，后续 m7aRoot() 优先读它。 */
export function m7aPointerPath() {
  return path.join(stateDir(), 'm7a-root.txt');
}

/** M7A 自己维护的安装登记表（GUI 每次启动都会写）。 */
export function m7aInstallsJsonPath() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'March7thAssistant', 'installs.json');
}

const CONFIG_WHITELIST = [
  'game_path',
  'after_finish',
  'daily_enable',
  'power_enable',
  'auto_set_resolution_enable',
  'auto_set_game_path_enable',
  'pause_after_success',
  'exit_after_failure',
  'check_update',
  'cloud_game_enable',
  'start_game_timeout',
  // 体力用途（对齐用户口径：只刷培养角色的材料/遗器，不打信用点与角色经验）
  'instance_type',
  'activity_gardenofplenty_instance_type',
  'build_target_enable',
  'echo_of_war_enable',
  'power_plan_keep',
];

export function m7aConfigWhitelist() {
  return CONFIG_WHITELIST.slice();
}

/** 某个具体目录下的 M7A 是否完整（不用于探测候选，只做校验）。 */
export function inspectM7aInstallRoot(root) {
  const dir = String(root || '').trim();
  const file = (name) => path.join(dir, name);
  const exe = file('m7a.exe');
  const launcher = file('March7th Launcher.exe');
  const legacy = file('March7th Assistant.exe');
  const config = file('config.yaml');
  const exampleConfig = path.join(dir, 'assets', 'config', 'config.example.yaml');
  const versionFile = path.join(dir, 'assets', 'config', 'version.txt');
  const runsDir = path.join(dir, 'logs', 'runs');
  const hasExe = Boolean(dir) && existsSync(exe);
  const looksLikeRoot = Boolean(dir) && (existsSync(exampleConfig) || existsSync(launcher) || existsSync(legacy) || existsSync(config));
  let version = '';
  try {
    version = readFileSync(versionFile, 'utf8').trim().slice(0, 80);
  } catch {
    version = '';
  }
  return {
    root: dir,
    exe,
    launcher,
    legacy,
    config,
    exampleConfig,
    versionFile,
    runsDir,
    hasExe,
    looksLikeRoot,
    version,
    /** 旧版（没有 m7a.exe）也算「找到了安装」，但要提示升级。 */
    ok: hasExe && looksLikeRoot,
    legacyOnly: !hasExe && looksLikeRoot,
  };
}

/** 从 installs.json 里容错地读出所有登记过的安装路径。 */
export function readInstallBookmarks() {
  const file = m7aInstallsJsonPath();
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { file, paths: [], error: 'missing' };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { file, paths: [], error: 'bad-json' };
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data && data.installs)
      ? data.installs
      : Array.isArray(data && data.data)
        ? data.data
        : [];
  const paths = [];
  for (const item of list) {
    if (typeof item === 'string') {
      paths.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const candidate =
      item.path || item.install_path || item.installPath || item.root || item.dir || item.directory || item.location;
    if (candidate) paths.push(String(candidate));
  }
  if (!paths.length && data && typeof data === 'object') {
    for (const value of Object.values(data)) {
      if (typeof value === 'string' && /[\\/]/.test(value)) paths.push(value);
    }
  }
  return { file, paths, error: '' };
}

function candidateRoots() {
  const home = os.homedir();
  const list = [
    path.join(home, 'Games', 'March7thAssistant'),
    'D:\\March7thAssistant',
    'E:\\software\\March7thAssistant',
    'D:\\software\\March7thAssistant',
    path.join(home, 'March7thAssistant'),
  ];
  const unique = [];
  for (const dir of list) if (dir && !unique.includes(dir)) unique.push(dir);
  return unique;
}

/** 找到可用的 M7A 根目录；找不到返回 ''（调用方负责给用户可执行的提示）。 */
export function m7aRoot() {
  const fromEnv = (process.env.DSH_GAME_DAILY_M7A_ROOT || process.env.M7A_ROOT || '').trim();
  if (fromEnv && inspectM7aInstallRoot(fromEnv).ok) return fromEnv;
  try {
    const pointer = readFileSync(m7aPointerPath(), 'utf8').trim();
    if (pointer && inspectM7aInstallRoot(pointer).ok) return pointer;
  } catch {
    /* 没有书签就继续探测 */
  }
  const bookmarks = readInstallBookmarks();
  for (const dir of bookmarks.paths) {
    if (inspectM7aInstallRoot(dir).ok) return dir;
  }
  for (const dir of candidateRoots()) {
    if (inspectM7aInstallRoot(dir).ok) return dir;
  }
  return '';
}

export function m7aInstallInfo() {
  const root = m7aRoot();
  if (root) {
    return { ok: true, root, install: inspectM7aInstallRoot(root), bookmarks: readInstallBookmarks() };
  }
  const bookmarks = readInstallBookmarks();
  const legacy = [...bookmarks.paths, ...candidateRoots()]
    .map((dir) => inspectM7aInstallRoot(dir))
    .find((info) => info.legacyOnly);
  return {
    ok: false,
    root: '',
    error: 'M7A_NOT_INSTALLED',
    hint: M7A_MISSING_HINT,
    bookmarks,
    legacyOnly: Boolean(legacy),
    legacyRoot: legacy ? legacy.root : '',
    searched: [...bookmarks.paths, ...candidateRoots()].filter(Boolean).slice(0, 8),
  };
}

export const M7A_MISSING_HINT =
  '未找到三月七小助手（m7a.exe）。装法：GitHub Releases 下载 March7thAssistant_full.zip → 解压到 %USERPROFILE%\\Games\\March7thAssistant（别装 C:\\Program Files）→ 打开 March7th Launcher.exe 由用户本人确认免责声明 → 在图形界面确认游戏路径。也可点本插件的「修复」让 DSH 协助安装与配置。';

/** 记录安装位置（体检/修复成功后调用）。 */
export function writeM7aPointer(root) {
  try {
    fs.mkdirSync(path.dirname(m7aPointerPath()), { recursive: true });
    fs.writeFileSync(m7aPointerPath(), String(root || '').trim(), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 从混合输出里抠出第一段 JSON（M7A 的 JSON 只含 ASCII，前后可能有日志行）。 */
export function extractJson(text) {
  const s = String(text || '');
  const starts = [];
  const objAt = s.indexOf('{');
  const arrAt = s.indexOf('[');
  if (objAt >= 0) starts.push({ at: objAt, close: '}' });
  if (arrAt >= 0) starts.push({ at: arrAt, close: ']' });
  if (!starts.length) return null;
  starts.sort((a, b) => a.at - b.at);
  const { at, close } = starts[0];
  const end = s.lastIndexOf(close);
  if (end <= at) return null;
  try {
    return JSON.parse(s.slice(at, end + 1));
  } catch {
    return null;
  }
}

function spawnM7a(root, args, { timeoutMs = 30000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  const exe = path.join(root, 'm7a.exe');
  const result = spawnSync(exe, args, {
    cwd: root,
    timeout: timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  return {
    ok: result.status === 0,
    code: typeof result.status === 'number' ? result.status : null,
    timedOut,
    stdout,
    stderr,
    error: result.error ? String(result.error.message || result.error) : '',
    args,
  };
}

/** m7a.exe --status --json 的同步封装（给依赖体检用）。 */
export function m7aStatusSync({ timeoutMs = 25000 } = {}) {
  const info = m7aInstallInfo();
  if (!info.ok) return { ok: false, ...info };
  const res = spawnM7a(info.root, ['--status', '--json'], { timeoutMs });
  const data = extractJson(res.stdout) || extractJson(res.stderr);
  if (!data) {
    return {
      ok: false,
      root: info.root,
      error: 'M7A_STATUS_UNPARSABLE',
      hint: 'm7a.exe --status --json 没有输出可解析的 JSON；旧版本可能没有 m7a.exe，请更新小助手。',
      exitCode: res.code,
      timedOut: res.timedOut,
      raw: (res.stdout || res.stderr || '').slice(0, 600),
    };
  }
  return {
    ok: true,
    root: info.root,
    install: info.install,
    version: data.version || info.install.version || '',
    exitCode: res.code,
    status: data,
  };
}

/** m7a.exe --list --json：任务 id 与名称。 */
export function m7aListSync({ timeoutMs = 25000 } = {}) {
  const info = m7aInstallInfo();
  if (!info.ok) return { ok: false, ...info };
  const res = spawnM7a(info.root, ['--list', '--json'], { timeoutMs });
  const data = extractJson(res.stdout) || extractJson(res.stderr);
  if (!data) {
    return { ok: false, root: info.root, error: 'M7A_LIST_UNPARSABLE', exitCode: res.code, raw: (res.stdout || '').slice(0, 400) };
  }
  return { ok: true, root: info.root, tasks: data, exitCode: res.code };
}

/** 读 config.yaml 的白名单键（行内 `key: value # comment` 形式）。 */
export function m7aReadConfig(rootInput) {
  const root = rootInput || m7aRoot();
  if (!root) return { ok: false, error: 'M7A_NOT_INSTALLED' };
  const file = path.join(root, 'config.yaml');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, root, file, error: `读不到 config.yaml：${String((error && error.message) || error)}` };
  }
  const values = {};
  for (const key of CONFIG_WHITELIST) {
    const re = new RegExp(`^${key}\\s*:\\s*([^#\\r\\n]*)`, 'm');
    const m = re.exec(text);
    if (m) values[key] = m[1].trim();
  }
  const scheduled = /^scheduled_tasks\s*:\s*(.*)$/m.exec(text);
  return {
    ok: true,
    root,
    file,
    values,
    scheduledTasksInline: scheduled ? scheduled[1].trim() : '',
  };
}

/** 最近若干次运行记录（logs/runs/*.json，按修改时间倒序）。 */
export function m7aRecentRuns(rootInput, limit = 5) {
  const root = rootInput || m7aRoot();
  if (!root) return [];
  const dir = path.join(root, 'logs', 'runs');
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json'));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    rows.push({ file, name, mtimeMs: st.mtimeMs });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const row of rows.slice(0, Math.max(1, limit))) {
    let record = null;
    try {
      record = JSON.parse(readFileSync(row.file, 'utf8'));
    } catch {
      record = null;
    }
    out.push({ runId: row.name.replace(/\.json$/i, ''), file: row.file, mtime: new Date(row.mtimeMs).toISOString(), record });
  }
  return out;
}

/** 读单次运行记录；run 省略或 'latest' 时取最近一次。 */
export function m7aRunRecord(rootInput, run = 'latest') {
  const root = rootInput || m7aRoot();
  if (!root) return { ok: false, error: 'M7A_NOT_INSTALLED' };
  const dir = path.join(root, 'logs', 'runs');
  const wanted = String(run || 'latest');
  if (wanted === 'latest') {
    const recent = m7aRecentRuns(root, 1);
    if (!recent.length) return { ok: false, root, error: 'NO_RUNS' };
    return { ok: true, root, runId: recent[0].runId, file: recent[0].file, record: recent[0].record };
  }
  const file = path.join(dir, `${wanted.replace(/\.json$/i, '')}.json`);
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return { ok: true, root, runId: wanted, file, record };
  } catch (error) {
    return { ok: false, root, error: `读不到运行记录：${String((error && error.message) || error)}`, file };
  }
}

/** 当天日志末尾若干行（logs/<yyyy-MM-dd>.log，UTF-8）。 */
export function m7aTodayLogTail(rootInput, lines = 40) {
  const root = rootInput || m7aRoot();
  if (!root) return { ok: false, error: 'M7A_NOT_INSTALLED' };
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const file = path.join(root, 'logs', `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, root, file, error: `读不到当天日志：${String((error && error.message) || error)}` };
  }
  const all = text.split(/\r?\n/);
  const tail = all.slice(Math.max(0, all.length - Math.max(1, lines)));
  return { ok: true, root, file, lines: tail };
}

/** 运行一次任务（同步，适合短任务或 --status 类调用；长任务请在 agent 侧用 --detach）。 */
export function m7aRunSync(taskId, { timeoutMs = 45 * 60 * 1000, afterFinish = 'None', extraArgs = [] } = {}) {
  const info = m7aInstallInfo();
  if (!info.ok) return { ok: false, ...info };
  const args = [String(taskId || DEFAULT_M7A_TASK)];
  if (afterFinish) args.push('--after-finish', afterFinish);
  args.push('--json', ...extraArgs);
  const res = spawnM7a(info.root, args, { timeoutMs });
  const record = extractJson(res.stdout) || extractJson(res.stderr);
  const meaning = exitMeaning(res.code);
  return {
    ok: res.ok,
    root: info.root,
    taskId: args[0],
    exitCode: res.code,
    meaning,
    timedOut: res.timedOut,
    record,
    raw: res.ok ? '' : (res.stdout || res.stderr || '').slice(-1200),
  };
}

/** 控制正在运行的任务：pause / resume / stop。 */
export function m7aControlSync(action, { timeoutMs = 20000 } = {}) {
  const root = m7aRoot();
  if (!root) return { ok: false, error: 'M7A_NOT_INSTALLED' };
  const res = spawnM7a(root, ['--control', 'current', String(action)], { timeoutMs });
  const data = extractJson(res.stdout) || extractJson(res.stderr);
  return { ok: res.ok, root, action, exitCode: res.code, meaning: exitMeaning(res.code), data, raw: (res.stdout || res.stderr || '').slice(0, 800) };
}

/** 给 prompt 用的一段环境事实（找不到安装时也给明确指引）。 */
export function m7aFacts() {
  const info = m7aInstallInfo();
  if (!info.ok) {
    const lines = [
      '- 三月七小助手：**未安装**（没有找到 m7a.exe）',
      `- 影响：本轮无法用 M7A 代理；按 R7 停手并如实报告，不要改用坐标点击硬跑。`,
      `- 修复：${M7A_MISSING_HINT}`,
    ];
    if (info.legacyRoot) lines.push(`- 另发现旧版目录（只有 March7th Assistant.exe）：${info.legacyRoot}，建议让用户更新到带 m7a.exe 的新版。`);
    return { ok: false, lines };
  }
  const status = m7aStatusSync();
  const lines = [`- 三月七小助手：${info.root}${info.install.version ? `（版本 ${info.install.version}）` : ''}`];
  if (status.ok && status.status) {
    const s = status.status;
    lines.push(
      `- 状态：first_run_completed=${s.first_run_completed}；game_path_exists=${s.game_path_exists}；cloud_game_enable=${s.cloud_game_enable}；active_run=${
        s.active_run
          ? `${s.active_run.task || '?'}（${s.active_run.run_id || s.active_run.id || '?'}，pid ${s.active_run.pid || '?'}，始于 ${s.active_run.started_at || '?'}）`
          : '无'
      }`,
    );
    const recent = Array.isArray(s.recent_runs) ? s.recent_runs.slice(0, 3) : [];
    for (const run of recent) {
      lines.push(`  · 最近运行 ${run.run_id || run.id || '?'}：${run.status || '?'}${run.reason ? ` / ${run.reason}` : ''}`);
    }
  } else {
    lines.push(`- 状态：读取失败（${status.error || '未知'}）${status.hint ? `；${status.hint}` : ''}`);
  }
  const task = DEFAULT_M7A_TASK;
  lines.push(
    `- 运行入口：\`${path.join(info.root, 'm7a.exe')} ${task} --after-finish None --json\`（长任务用 --detach 再 --follow latest）`,
    '- 退出码：0 成功 / 1 任务失败 / 2 参数错 / 3 首次未确认（用户本人确认）/ 4 已有任务在跑 / 5 UAC 取消 / 6 被停止',
  );
  return { ok: true, lines, root: info.root, status: status.ok ? status.status : null, task };
}

export default { m7aRoot, m7aInstallInfo, m7aStatusSync, m7aFacts, DEFAULT_M7A_TASK };

// ---------------------------------------------------------------------------
// 以下是我们这边保留的部分（与上游的 m7a.exe 控制层并存）：
//   · 直接跑 M7A（不经 agent）：runner 靠这些函数拉起、收日志、出报告
//   · 体力计划：写进 M7A 的 config.yaml，跑之前补齐
// ---------------------------------------------------------------------------

export const M7A_DEFAULT_ROOTS = [
  'D:\\March7thAssistant_full\\March7thAssistant_full',
  'D:\\March7thAssistant',
  'D:\\software\\March7thAssistant',
  path.join(os.homedir(), 'March7thAssistant'),
];

const EXE_NAMES = ['March7th Assistant.exe', 'March7thAssistant.exe'];

/** M7A 的 CLI 任务名（--list 的子集；只列日常会用到的）。 */

export const M7A_TASKS = [
  'main',
  'daily',
  'routine',
  'power',
  'fight',
  'universe',
  'forgottenhall',
  'purefiction',
  'apocalyptic',
  'redemption',
];

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 体力计划默认值：3 次侵蚀隧洞（睿治之径）= 120 开拓力。
 * 正好凑够每日实训「累计消耗 120 点开拓力」那 100 活跃度。
 */

export const DEFAULT_POWER_PLAN = [['侵蚀隧洞', '睿治之径', 3]];

/** 从环境变量读体力计划：DSH_GAME_DAILY_M7A_POWER_PLAN="侵蚀隧洞,睿治之径,3" */

export function resolvePowerPlan() {
  const raw = String(process.env.DSH_GAME_DAILY_M7A_POWER_PLAN || '').trim();
  if (!raw) return DEFAULT_POWER_PLAN;
  const parts = raw.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  if (parts.length < 2) return DEFAULT_POWER_PLAN;
  const count = Number(parts[2]) || 1;
  return [[parts[0], parts[1], Math.max(1, count)]];
}

/**
 * 跑之前把体力计划补回 M7A 的 config.yaml。
 *
 * 坑：M7A 的 `power_plan_keep: false` 表示「跑完按剩余次数更新并删除已完成条目」，
 * 于是每天跑完体力计划，config.yaml 里的 power_plan 就变成空的了；
 * 第二天再跑就只剩「清体力」，会把 300 开拓力全砸进拟造花萼（30 轮 ≈ 40 分钟），
 * 反而没跑睿治之径。
 */

export function ensurePowerPlan(m7a, plan = resolvePowerPlan()) {
  const file = m7a && m7a.config;
  if (!file || !exists(file)) return { ok: false, error: `M7A 配置不存在：${file}` };
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  const keepLine = 'power_plan_keep: true # 插件托管：保留体力计划，明天接着跑';
  const planRe = /^power_plan:.*$/m;
  const keepRe = /^power_plan_keep:.*$/m;
  const currentPlan = planRe.exec(text);
  const currentKeep = keepRe.exec(text);
  // 已经有一份计划就别覆盖：M7A 自己会按剩余次数更新它。
  // 每次都写回满额的话，同一天的补跑会再刷一遍体力（白烧 120 开拓力）。
  const hasPlan = Boolean(currentPlan && /\[\s*\[/.test(currentPlan[0]));
  const planLine = hasPlan ? currentPlan[0] : `power_plan: ${JSON.stringify(plan)}`;
  const wantPlan = planLine;
  const wantKeep = keepLine;
  if (currentPlan && currentPlan[0].trim() === wantPlan && currentKeep && currentKeep[0].trim() === wantKeep) {
    return { ok: true, changed: false, file, plan, kept: hasPlan };
  }
  let next = text;
  next = planRe.test(next) ? next.replace(planRe, wantPlan) : `${next}\n${wantPlan}\n`;
  next = keepRe.test(next) ? next.replace(keepRe, wantKeep) : `${next}\n${wantKeep}\n`;
  const backup = `${file}.bak-${Date.now()}`;
  try {
    fs.writeFileSync(backup, text, 'utf8');
    fs.writeFileSync(file, next, 'utf8');
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  return { ok: true, changed: true, file, backup, plan, kept: hasPlan };
}

function firstExisting(files) {
  for (const file of files) {
    if (file && exists(file)) return file;
  }
  return '';
}

/**
 * 定位 March7th Assistant.exe。
 * 优先级：DSH_GAME_DAILY_M7A（文件或目录）→ 命令行状态里的 m7aPath → 默认位置。
 */

export function resolveM7a({ configured = '' } = {}) {
  const candidates = [];
  const env = String(process.env.DSH_GAME_DAILY_M7A || '').trim();
  if (env) {
    candidates.push(...EXE_NAMES.map((name) => path.join(env, name)), env);
  }
  if (configured) {
    candidates.push(...EXE_NAMES.map((name) => path.join(configured, name)), configured);
  }
  for (const root of M7A_DEFAULT_ROOTS) {
    candidates.push(...EXE_NAMES.map((name) => path.join(root, name)));
  }
  const exe = firstExisting(candidates);
  if (!exe) return null;
  return { exe, root: path.dirname(exe), config: path.join(path.dirname(exe), 'config.yaml') };
}

/** 这一轮跑哪些 M7A 任务：环境变量（逗号分隔）> 游戏注册表 > 默认 ['daily']。 */

export function resolveM7aTasks(game) {
  const env = String(process.env.DSH_GAME_DAILY_M7A_TASK || '').trim();
  if (env) {
    const list = env
      .split(/[,;\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (list.length) return list;
  }
  const registered = game && Array.isArray(game.m7aTasks) ? game.m7aTasks.filter(Boolean) : [];
  if (registered.length) return registered;
  const single = game && typeof game.m7aTask === 'string' ? game.m7aTask.trim() : '';
  return single ? [single] : ['daily'];
}

const SECTION_RE = /^\|\s*(\S.*?)\s*\|\s*$/;
const ERROR_RE = /(^|\|\s*)(ERROR|CRITICAL)\s*(\||$)|Traceback \(most recent call last\)|发生错误/;
// 收尾只认 M7A 的「停止运行」小节：早先还匹配「任务完成」等字样，
// 任意一行带这几个字都会把 terminated 提前置真，状态被判成成功。
const DONE_RE = /停止运行/;
// M7A 启动横幅：欢迎语、项目地址、开源提示——它们也是 `| ... |` 形状，但不是任务小节。
const BANNER_RE = /欢迎使用|免费开源|退款|https?:\/\/|请访问|www\./i;
// 收尾「按回车键关闭窗口」读不到 stdin 时的报错：属于收尾噪音，不算任务失败。
const BENIGN_RE = /EOF when reading a line|按回车键关闭窗口|按回车键/;
// M7A 会把每个每日实训任务的结果写成一行，这里解析成逐步骤：
//   派遣委托或收取1次委托奖励: 已完成 +100分，当前分数: 200/500
//   累计消耗120点开拓力: 待完成
//   邮件奖励已领取
// M7A 会把每个每日实训任务的结果写成一行，日志与 stdout 两种写法都要认：
//   登录游戏: 已完成 +  (+100分)]
//   完成任务: 登录游戏 (+100分)，当前分数: 200/500
//   累计消耗120点开拓力: 待完成
//   任务无法完成: 累计消耗120点开拓力
//   邮件奖励已领取
const TASK_DONE_RE = /^(.+?):\s*已完成(?:\s|$)/;
const TASK_DONE_ALT_RE = /^完成任务[:：]\s*(.+?)\s*\(\s*\+\s*\d+\s*分\s*\)[，,]?\s*(?:当前分数[:：]\s*(\d+\/\d+))?/;
const TASK_PENDING_RE = /^(.+?):\s*待完成$/;
const TASK_FAILED_RE = /^任务无法完成[:：]\s*(.+)$/;
const REWARD_CLAIMED_RE = /^(.+?奖励)已领取$/;
// 「活跃度已满」= 这一轮开始时，日常就已经做完了（不是失败）。
// 跨天场景（0 点后、4 点重置前）尤其重要：这时做的其实是昨天的日常。
const ACTIVITY_FULL_RE = /检测到本日活跃度已满|活跃度已满/;
const SCORE_REACHED_RE = /实训分数已达标|活跃度已满|分数已达标/;
const NOTHING_RE = /^未检测到(.+)$/;
// M7A 日志行首形如 `2026-10-30 20:16:08,714 | INFO | 消息`，还带 ANSI 颜色码。
const LOG_PREFIX_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[,.]?\d*\s*\|\s*[A-Za-z]+\s*\|\s*/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
// 级别在剥前缀时会被一起剥掉，所以要在剥之前先把 ERROR/CRITICAL 认出来。
// 少了这一步，一轮 50 多条 ERROR 的失败会被当成「没有错误」。
const LOG_LEVEL_ERROR_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[,.]?\d*\s*\|\s*(ERROR|CRITICAL)\s*\|\s*(.*)$/i;

function messageOf(line) {
  return String(line || '')
    .replace(ANSI_RE, '')
    .replace(LOG_PREFIX_RE, '')
    .trim();
}

/**
 * 从 M7A 的 stdout / 日志里提炼报告字段。
 * M7A 的日志是「小节标题 + INFO 行」的格式，小节标题形如 `| 开始领取奖励 |`，
 * 结束标志是 `| 停止运行 |` 后再跟一行 `完成`。
 */

export function parseM7aLog(text, exitCode) {
  const lines = String(text || '').split(/\r?\n/);
  const steps = [];
  const errors = [];
  const notes = [];
  const phases = [];
  const nothing = [];
  let terminated = false;
  let score = '';
  let activityFull = false;
  let scoreReached = false;

  const addStep = (name, ok, detail) => {
    if (!name) return;
    const clean = name.replace(/^每日实训[:：]?\s*/, '').trim();
    if (!clean || clean.length > 60) return;
    const exist = steps.find((s) => s.name === clean);
    if (exist) {
      // M7A 先列一遍任务状态（待完成），做完再补一行「已完成 +N 分」。
      // 所以后出现的「已完成」要能覆盖前面的「待完成」，否则明明做完了却标成未完成。
      if (ok && exist.ok !== true) exist.ok = true;
      if (detail) exist.detail = detail;
      return;
    }
    steps.push({ name: clean, ok, detail: detail || '' });
  };

  for (const line of lines) {
    // 先认级别（ERROR/CRITICAL），再剥前缀 —— 剥完就找不回来了。
    const levelError = LOG_LEVEL_ERROR_RE.exec(String(line || '').replace(ANSI_RE, ''));
    const trimmed = messageOf(line);
    if (levelError) {
      const message = levelError[2].trim();
      // 收尾噪音（EOF 等待回车）不算失败。
      if (!BENIGN_RE.test(message)) errors.push(`${levelError[1].toUpperCase()}: ${message}`.slice(0, 200));
      continue;
    }
    if (!trimmed) continue;
    const section = SECTION_RE.exec(trimmed);
    if (section) {
      const name = section[1].trim();
      if (name && !/^-+$/.test(name) && !BANNER_RE.test(name)) phases.push(name);
      if (/停止运行/.test(name)) terminated = true;
      continue;
    }
    const doneAlt = TASK_DONE_ALT_RE.exec(trimmed);
    if (doneAlt) {
      if (doneAlt[2]) score = doneAlt[2];
      addStep(doneAlt[1].trim(), true, trimmed.slice(0, 120));
      continue;
    }
    const done = TASK_DONE_RE.exec(trimmed);
    if (done) {
      const m = trimmed.match(/当前分数[:：]\s*(\d+\/\d+)/);
      if (m) score = m[1];
      addStep(done[1].trim(), true, trimmed.slice(0, 120));
      continue;
    }
    const pending = TASK_PENDING_RE.exec(trimmed);
    if (pending) {
      addStep(pending[1].trim(), false, '本次未完成');
      continue;
    }
    const failed = TASK_FAILED_RE.exec(trimmed);
    if (failed) {
      addStep(failed[1].trim(), false, '本次未完成');
      continue;
    }
    const claimed = REWARD_CLAIMED_RE.exec(trimmed);
    if (claimed) {
      addStep(claimed[1].trim(), true, '已领取');
      continue;
    }
    if (ACTIVITY_FULL_RE.test(trimmed)) {
      activityFull = true;
      // 名字不要带「每日实训」前缀：addStep 会把它剥掉。
      addStep('活跃度', true, '已满（此前已完成）');
      continue;
    }
    if (SCORE_REACHED_RE.test(trimmed)) {
      scoreReached = true;
      continue;
    }
    const empty = NOTHING_RE.exec(trimmed);
    if (empty) {
      nothing.push(empty[1].trim());
      continue;
    }
    if (ERROR_RE.test(trimmed) && !BENIGN_RE.test(trimmed)) errors.push(trimmed.slice(0, 200));
    if (DONE_RE.test(trimmed)) terminated = true;
  }

  let status;
  if (!terminated && Number(exitCode) !== 0) status = 'failed';
  else if (errors.length) status = 'partial';
  else if (terminated) status = 'success';
  else status = 'partial';

  const pending = steps.filter((s) => s.ok === false).map((s) => s.name);
  // 全部任务都已完成时 M7A 不会打印逐条结果，此时用阶段链兜底，面板上仍有内容可看。
  // 这些是「阶段标题」不是「完成的任务」，标成 kind:'phase'，
  // 每日检查点会跳过它们（否则清单里会出现「今天做完了 开始清体力」这种条目）。
  if (!steps.length && phases.length) {
    for (const phase of phases) steps.push({ name: phase, ok: true, detail: '阶段', kind: 'phase' });
  }
  if (pending.length) {
    if (scoreReached) {
      // 活跃度已经满分（500/500），剩下没做的多半是本地区拓展任务（差分宇宙/合成机之类），
      // 不计入这一轮活跃度，不该把整轮判成「部分完成」，
      // 也不该在每日检查点里留下「还差这几项」的假缺口 —— 活跃度满了就是做完了。
      for (const step of steps) {
        if (step.ok !== false) continue;
        step.ok = true;
        step.detail = `活跃度已达标${score ? `（${score}）` : ''}，本轮不计入`;
      }
      notes.push(
        `每日实训活跃度已达标${score ? `（${score}）` : ''}，下列任务未计入本轮活跃度、本次没做：${pending.join('、')}`,
      );
    } else {
      status = status === 'failed' ? 'failed' : 'partial';
      notes.push(`本次未完成的每日实训任务：${pending.join('、')}`);
    }
  }
  if (score) notes.push(`每日实训活跃度：${score}`);
  if (activityFull) {
    notes.push('日志显示「本日活跃度已满」：日常在这轮开始之前就已经做完，本次没有可领的内容（不算失败）。');
  }
  if (nothing.length) notes.push(`本轮没有可领取的条目：${nothing.slice(0, 6).join('、')}`);
  if (phases.length) notes.push(`M7A 阶段：${phases.slice(0, 12).join(' → ')}`);
  if (errors.length) notes.push(`日志里有 ${errors.length} 条错误，首条：${errors[0]}`);
  if (!terminated) {
    notes.push(
      Number(exitCode) === 0
        ? '进程正常退出，但日志里没有「停止运行」收尾标记（可能是被提前结束，或 M7A 弹了对话框在等确认）。'
        : '进程非 0 退出且没有收尾标记；若很快退出，通常是 M7A 需要管理员权限（会自己弹一次 UAC）。',
    );
  }
  return {
    status,
    steps,
    phases,
    errors: errors.slice(0, 10),
    notes: notes.join('\n'),
    evidence: [
      `exitCode=${exitCode}`,
      `terminated=${terminated}`,
      `steps=${steps.length}`,
      `phases=${phases.length}`,
      `errors=${errors.length}`,
      `activityFull=${activityFull}`,
      `scoreReached=${scoreReached}`,
    ],
  };
}

/** 兜底报告：M7A 不写插件格式的 report.json，由 runner 按日志生成。 */

export function m7aReport({ gameId, mode, runId, exitCode, startedAt, logText, resetHour = 4 }) {
  const parsed = parseM7aLog(logText, exitCode);
  const extra = [];
  // 跨天提示：0 点到 4 点之间起的这一轮，做的是**上一日**的日常（游戏还没重置）。
  try {
    const started = new Date(startedAt);
    if (!Number.isNaN(started.getTime()) && started.getHours() < Number(resetHour)) {
      extra.push(
        `本轮在凌晨 ${resetHour} 点重置点之前开始（${started.getHours()} 点），游戏里做的仍是上一日的日常；` +
          '幂等判断按业务日计算，不会因此挡住今天这一轮。',
      );
    }
  } catch {
    /* ignore */
  }
  return {
    schemaVersion: 1,
    runId,
    game: gameId,
    mode,
    status: parsed.status,
    startedAt: startedAt || '',
    endedAt: new Date().toISOString(),
    steps: parsed.steps,
    evidence: parsed.evidence,
    screenshots: [],
    notes: [parsed.notes, ...extra, '由 March7thAssistant 执行（插件只负责调度与记账）。'].filter(Boolean).join('\n'),
    generatedBy: 'runner-m7a',
  };
}
