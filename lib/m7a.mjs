// 崩坏：星穹铁道——走 March7thAssistant（三月七小助手，M7A）的命令行，
// 代替「截图 → 认屏 → 坐标点击」那一套。M7A 自带 OCR 与战斗识别，
// 一条 daily 就能跑完清体力 / 每日实训 / 领取奖励，比手推稳得多。
//
// 命令行（见 M7A 的 main.py）：
//   "March7th Assistant.exe" daily      # 每日实训 + 领取奖励
//   "March7th Assistant.exe" main       # 完整运行（版本检查 + 启动 + 日常 + 奖励）
//   "March7th Assistant.exe" --list     # 列出全部任务
//
// 注意：M7A 自身是 requireAdministrator，非管理员启动会自己弹 UAC 并退出，
// 所以计划任务（最高权限）里跑才是零弹窗的路径。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** M7A 常见安装位置；可用 DSH_GAME_DAILY_M7A 覆盖（指到 exe 或目录都行）。 */
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
      // 不计入这一轮活跃度，不该把整轮判成「部分完成」。
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
