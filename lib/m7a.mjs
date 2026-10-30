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

/** 这一轮跑哪个 M7A 任务：环境变量 > 游戏注册表 > daily。 */
export function resolveM7aTask(game) {
  const env = String(process.env.DSH_GAME_DAILY_M7A_TASK || '').trim();
  if (env) return env;
  const task = game && typeof game.m7aTask === 'string' ? game.m7aTask.trim() : '';
  return task || 'daily';
}

const SECTION_RE = /^\|\s*(\S.*?)\s*\|\s*$/;
const ERROR_RE = /(^|\|\s*)(ERROR|CRITICAL)\s*(\||$)|Traceback \(most recent call last\)|发生错误/;
const DONE_RE = /停止运行|任务完成|全部完成|日常完成/;
// M7A 启动横幅：欢迎语、项目地址、开源提示——它们也是 `| ... |` 形状，但不是任务小节。
const BANNER_RE = /欢迎使用|免费开源|退款|https?:\/\/|请访问|www\./i;
// 收尾「按回车键关闭窗口」读不到 stdin 时的报错：属于收尾噪音，不算任务失败。
const BENIGN_RE = /EOF when reading a line|按回车键关闭窗口|按回车键/;

/**
 * 从 M7A 的 stdout / 日志里提炼报告字段。
 * M7A 的日志是「小节标题 + INFO 行」的格式，小节标题形如 `| 开始领取奖励 |`，
 * 结束标志是 `| 停止运行 |` 后再跟一行 `完成`。
 */
export function parseM7aLog(text, exitCode) {
  const lines = String(text || '').split(/\r?\n/);
  const steps = [];
  const errors = [];
  let terminated = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const section = SECTION_RE.exec(trimmed);
    if (section) {
      const name = section[1].trim();
      if (name && !/^-+$/.test(name) && !BANNER_RE.test(name) && !steps.some((s) => s.name === name)) {
        steps.push({ name, ok: true, detail: '' });
      }
      if (/停止运行/.test(name)) terminated = true;
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

  const notes = [];
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
    errors: errors.slice(0, 10),
    notes: notes.join('\n'),
    evidence: [`exitCode=${exitCode}`, `terminated=${terminated}`, `steps=${steps.length}`, `errors=${errors.length}`],
  };
}

/** 兜底报告：M7A 不写插件格式的 report.json，由 runner 按日志生成。 */
export function m7aReport({ gameId, mode, runId, exitCode, startedAt, logText }) {
  const parsed = parseM7aLog(logText, exitCode);
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
    notes: [parsed.notes, '由 March7thAssistant 执行（插件只负责调度与记账）。'].filter(Boolean).join('\n'),
    generatedBy: 'runner-m7a',
  };
}
