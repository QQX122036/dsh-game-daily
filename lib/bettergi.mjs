// 原神：直连 BetterGI 的「一条龙」命令行（startOneDragon），不再让 headless agent 转述。
//
// 为什么改：BetterGI 自己的任务编排（识别、寻路、战斗）已经比 LLM 可靠，
// 让 agent 再包一层只会带来偏差和抖动。插件退回到「起进程 → 收日志 → 写报告」。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const BETTERGI_DEFAULT_EXE = 'D:\\software\\BetterGI\\BetterGI.exe';
export const BETTERGI_DEFAULT_ONEDRAGON = '日常';

/** 定位 BetterGI.exe：环境变量 > 插件配置 > 默认位置。 */
export function resolveBettergi({ configured = '' } = {}) {
  const candidates = [];
  const env = String(process.env.DSH_GAME_DAILY_BETTERGI || '').trim();
  if (env) candidates.push(env);
  if (configured) candidates.push(configured);
  candidates.push(BETTERGI_DEFAULT_EXE);
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) {
        const root = path.dirname(file);
        return { exe: file, root, logDir: path.join(root, 'log') };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 一条龙配置名：环境变量 > state 里的设置 > 默认「日常」。 */
export function bettergiConfigName(game, gameState) {
  const env = String(process.env.DSH_GAME_DAILY_BETTERGI_ONEDRAGON || '').trim();
  if (env) return env;
  const fromState = gameState && typeof gameState.oneDragon === 'string' ? gameState.oneDragon.trim() : '';
  if (fromState) return fromState;
  const fromGame = game && typeof game.oneDragon === 'string' ? game.oneDragon.trim() : '';
  return fromGame || BETTERGI_DEFAULT_ONEDRAGON;
}

/** 今天的 BetterGI 日志文件（按天切）。 */
export function bettergiLogFile(root, date = new Date()) {
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return path.join(root, 'log', `better-genshin-impact${stamp}.log`);
}

const STEP_MARKERS = [
  { name: '领取邮件', re: /领取邮件|邮件奖励/ },
  { name: '合成树脂', re: /合成树脂/ },
  { name: '自动秘境', re: /自动秘境|地脉异常|战斗策略/ },
  { name: '每日奖励', re: /领取每日委托|每日奖励|历练点/ },
  { name: '尘歌壶奖励', re: /尘歌壶|阿圆/ },
];

/**
 * 「每日奖励」只有真的领到了才算完成。
 * BetterGI 日志里那行是 `检查每日奖励结果："今日奖励已领取"`（成功）
 * 或 `检查每日奖励结果："未领取"，请手动检查！`（失败）——
 * 两种写法都包含「每日奖励」四个字，早先的关键词匹配会把它记成「已完成」，
 * 报告里出现「每日奖励 ok:true」却又附一句「每日奖励未领取」，自相矛盾。
 */
const DAILY_REWARD_CLAIMED_RE = /每日奖励结果[：:]\s*"[^"]*已领取/;

// 自动秘境的真实标记（BetterGI 0.66 实测）：
//   自动秘境任务：执行                 → 开始刷
//   检测到秘境结束提示(挑战达成)，结束秘境 → 刷完一轮
//   原粹树脂：16，浓缩树脂：0            → 跑完之后的剩余
// 早先只认 `使用 "xx", 数量：N` 这行，但原神消耗原粹树脂时 BetterGI 根本不打印它，
// 于是明明刷完一轮，统计出来也是 0 轮。
const DOMAIN_START_RE = /自动秘境任务：执行/;
const DOMAIN_DONE_RE = /检测到秘境结束提示/;
const RESIN_LEFT_RE = /原粹树脂：(\d+)，浓缩树脂：(\d+)/;

const DONE_RE = /一条龙和配置组任务结束/;

/**
 * 从 BetterGI 日志里提炼报告。
 * 只看「本次运行新增」的段落（调用方传增量文本），避免把昨天的内容算进来。
 */
export function parseBettergiLog(text, exitCode) {
  const lines = String(text || '').split(/\r?\n/);
  const steps = [];
  const notes = [];
  let terminated = false;
  let domainRuns = 0;
  let domainStarted = 0;
  let resinLeft = -1;
  let resinUsed = 0;
  let claimedDaily = true;
  let dailyRewardChecked = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (DONE_RE.test(trimmed)) {
      terminated = true;
      continue;
    }
    const used = trimmed.match(/使用\s*"([^"]+)",\s*数量：\s*(\d+)/);
    if (used) {
      resinUsed += Number(used[2]) || 0;
      domainRuns += 1;
    }
    if (DOMAIN_START_RE.test(trimmed)) domainStarted += 1;
    if (DOMAIN_DONE_RE.test(trimmed)) domainRuns += 1;
    const left = RESIN_LEFT_RE.exec(trimmed);
    if (left) resinLeft = Number(left[1]);
    if (/体力耗尽|设置轮次已达标/.test(trimmed)) notes.push('自动秘境：体力耗尽或达到轮次上限，正常收尾。');
    if (/每日奖励结果[：:]/.test(trimmed)) {
      dailyRewardChecked = true;
      if (DAILY_REWARD_CLAIMED_RE.test(trimmed)) {
        claimedDaily = true;
      } else {
        claimedDaily = false;
        notes.push('每日奖励未领取：每日委托尚未完成（BetterGI 一条龙不含委托），需手动做委托或把委托加进一条龙。');
      }
    }
    for (const marker of STEP_MARKERS) {
      if (!marker.re.test(trimmed)) continue;
      // 「每日奖励」只看结果行：没领到不能记成完成。
      if (marker.name === '每日奖励') {
        if (!dailyRewardChecked) continue;
        if (!claimedDaily) continue;
      }
      if (!steps.some((s) => s.name === marker.name)) {
        steps.push({ name: marker.name, ok: true, detail: '' });
      }
      break;
    }
  }
  // 领不到每日奖励时，单独记一条「未完成」的步骤，让面板能一眼看出缺口。
  if (dailyRewardChecked && !claimedDaily) {
    const idx = steps.findIndex((s) => s.name === '每日奖励');
    if (idx >= 0) steps[idx] = { ...steps[idx], ok: false, detail: '每日委托未完成，奖励未领取' };
    else steps.push({ name: '每日奖励', ok: false, detail: '每日委托未完成，奖励未领取' });
  }

  let status;
  if (!terminated && Number(exitCode) !== 0) status = 'failed';
  else if (terminated) status = claimedDaily ? 'success' : 'partial';
  else status = 'partial';

  if (!terminated) {
    notes.push(
      Number(exitCode) === 0
        ? '进程正常退出，但日志里没有「一条龙和配置组任务结束」收尾标记。'
        : '进程非 0 退出且没有收尾标记。若很快退出，通常是 BetterGI 需要管理员权限（它会自己弹一次 UAC）。',
    );
  }
  if (steps.length) {
    notes.push(
      `自动秘境跑了 ${domainRuns} 轮` +
        (resinLeft >= 0 ? `（跑完剩余原粹树脂 ${resinLeft}）` : '') +
        (resinUsed ? `，日志记录的树脂消耗 ${resinUsed}` : '') +
        '。',
    );
  }
  // 「出现了自动秘境」不等于「刷了」：0 轮要单独标出来，
  // 否则面板上「自动秘境 ✓」会让人以为今天刷过了（其实是没树脂或今天已跑过）。
  // 注意轮次要数「检测到秘境结束提示」——BetterGI 0.66 刷原粹树脂时
  // 不会打印 `使用 "xx", 数量：N`，只认那一行会把刷过的秘境算成 0 轮。
  const domainStep = steps.find((s) => s.name === '自动秘境');
  if (domainStep && domainRuns === 0) {
    domainStep.ok = false;
    domainStep.detail = domainStarted
      ? '进入了但没打完：日志里没有「挑战达成」，可能是树脂不足或中途被跳过'
      : '0 轮：没有可用的原粹树脂，或今天已经跑过';
  }

  return {
    status,
    steps,
    notes: notes.join('\n'),
    evidence: [
      `exitCode=${exitCode}`,
      `terminated=${terminated}`,
      `steps=${steps.length}`,
      `domainRuns=${domainRuns}`,
      `resinLeft=${resinLeft}`,
      `resin=${resinUsed}`,
    ],
  };
}

/** 兜底报告（BetterGI 自己不写插件格式的报告，由 runner 生成）。 */
export function bettergiReport({ gameId, mode, runId, exitCode, startedAt, logText }) {
  const parsed = parseBettergiLog(logText, exitCode);
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
    notes: [parsed.notes, '由 BetterGI 一条龙执行（插件只负责调度与记账）。'].filter(Boolean).join('\n'),
    generatedBy: 'runner-bettergi',
  };
}
