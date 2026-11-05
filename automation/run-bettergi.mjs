#!/usr/bin/env node
// 原神「一条龙」直连执行器（计划任务/插件的子进程）。
//
// 实测结论（2026-10-31）：`BetterGI.exe startOneDragon <配置>` 冷启动会自己
// 拉起原神并进入一条龙（约 4.5 分钟，含游戏启动与登录），所以这里只需三步：
//   1) 若已有 BetterGI 实例在跑先结束它——单实例会把命令行参数只做转发、不会真正执行；
//   2) 直接跑 `startOneDragon`；
//   3) 以日志里的收尾标记「一条龙和配置组任务结束」为准产出报告
//      （BetterGI 跑完后 GUI 会驻留，不能只等进程退出，否则会挂到超时），
//      收尾时结束我们自己拉起的 BetterGI。
//
// 这个脚本必须以管理员权限运行（BetterGI 与原神都是提权进程）；
// 计划任务以「最高权限」触发时天然满足，手动运行时由 runner 负责报错提示。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bettergiLogFile, bettergiReport } from '../lib/bettergi.mjs';
import { ensureCommissionFlows, parseCommissionTypes, loadCommissionTypes, saveCommissionTypes } from '../lib/bettergi-commission.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DONE_MARKER = '一条龙和配置组任务结束';
// 配置组（调度组）跑完的标记：脚本自己的收尾日志，或 BetterGI 统一的收尾行。
const GROUP_DONE_MARKERS = ['自动委托执行完毕', '一条龙和配置组任务结束'];

function parseArgs(argv) {
  const out = {
    root: 'D:\\software\\BetterGI',
    config: '日常',
    gameId: 'genshin',
    mode: 'real',
    runId: '',
    timeoutMin: 60,
    groups: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--root') out.root = argv[++i];
    else if (token === '--config') out.config = argv[++i];
    else if (token === '--game') out.gameId = argv[++i];
    else if (token === '--mode') out.mode = argv[++i];
    else if (token === '--run-id') out.runId = argv[++i];
    else if (token === '--timeout-min') out.timeoutMin = Number(argv[++i]) || 60;
    else if (token === '--state-dir') out.stateDir = String(argv[++i] || '');
    // 前置配置组：例如「每日委托」——必须先做完委托，一条龙的「领取每日奖励」才领得到。
    else if (token === '--groups') {
      out.groups = String(argv[++i] || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => process.stdout.write(`[bettergi] ${text}\n`);

/**
 * 报告用纯 ASCII 输出（中文转成 \uXXXX）。
 *
 * 这一行会被父进程从 stdout 里捞出来解析 —— 那一路上和控制台输出混在一起，
 * 编码不定（BetterGI 的控制台输出是 UTF-8，偶尔混进非法字节就会整段乱码）。
 * 转成 ASCII 之后，任何解码方式都不会影响报告里的中文。
 */
function jsonAscii(value) {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

function killBettergi() {
  try {
    execFileSync('taskkill.exe', ['/F', '/IM', 'BetterGI.exe'], { windowsHide: true, timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

function readSince(file, sizeBefore) {
  try {
    const stat = fs.statSync(file);
    if (stat.size <= sizeBefore) return '';
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - sizeBefore);
    fs.readSync(fd, buffer, 0, buffer.length, sizeBefore);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 按「文件 → 已读到的位置」跟踪日志增量。
 *
 * BetterGI 的日志**按天切文件**（better-genshin-impactYYYYMMDD.log）。
 * 22:0x 起跑、00:0x 收尾时，收尾标记会写进第二天那个文件 ——
 * 只盯着起跑那天的文件，就永远读不到收尾标记，只能干等到超时。
 */
function createLogReader(root) {
  const offsets = new Map();
  const startFile = bettergiLogFile(root);
  offsets.set(startFile, 0);
  try {
    offsets.set(startFile, fs.statSync(startFile).size);
  } catch {
    /* ignore */
  }
  return {
    /** 读取自上次以来新增的内容（跨零点会自动带上新文件）。 */
    read() {
      let text = '';
      const current = bettergiLogFile(root);
      if (!offsets.has(current)) offsets.set(current, 0);
      for (const [file, before] of [...offsets.entries()]) {
        const chunk = readSince(file, before);
        if (chunk) text += chunk;
        try {
          offsets.set(file, fs.statSync(file).size);
        } catch {
          /* ignore */
        }
      }
      return text;
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exe = path.join(args.root, 'BetterGI.exe');
  if (!fs.existsSync(exe)) {
    log(`找不到 ${exe}`);
    process.stdout.write(
      `##REPORT ${JSON.stringify(
        bettergiReport({ gameId: args.gameId, mode: args.mode, runId: args.runId, exitCode: -1, startedAt: new Date().toISOString(), logText: '' }),
      )}\n`,
    );
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();

  // 演练模式（dry）只做环境自检：不启动游戏、不跑一条龙、不碰 BetterGI 实例。
  // 之前脚本收了 --mode 却从没用它，演练会真的开跑 —— 这是必须堵住的红线。
  if (args.mode === 'dry') {
    const logFile = bettergiLogFile(args.root);
    let logExists = false;
    let logSize = 0;
    try {
      const stat = fs.statSync(logFile);
      logExists = true;
      logSize = stat.size;
    } catch {
      /* ignore */
    }
    log('演练模式：不启动游戏、不执行一条龙。');
    process.stdout.write(
      `##REPORT ${JSON.stringify({
        schemaVersion: 1,
        runId: args.runId,
        game: args.gameId,
        mode: 'dry',
        status: 'partial',
        startedAt,
        endedAt: new Date().toISOString(),
        steps: [],
        evidence: [`dry=true`, `bettergi=${fs.existsSync(exe) ? 'found' : 'missing'}`, `config=${args.config}`, `log=${logExists ? `${logSize}B` : 'none'}`],
        screenshots: [],
        notes: [
          '演练模式：没有启动游戏、没有执行一条龙、没有任何游戏内操作。',
          `只做了环境自检：BetterGI=${fs.existsSync(exe) ? '已就位' : '没找到'}，一条龙配置「${args.config}」，今日日志=${logExists ? `${logSize} 字节` : '还没有'}。`,
          '把模式切成「真实执行」才会真的跑日常。',
        ].join('\n'),
        generatedBy: 'runner-bettergi',
      })}\n`,
    );
    process.exit(0);
  }

  // 1) 清掉可能残留的 BetterGI 实例（单实例会把命令行只做转发）
  if (killBettergi()) {
    log('已结束残留的 BetterGI 实例（释放单实例）');
    await sleep(3000);
  }

  // 2) 前置配置组（例如「每日委托」）。
  //    一条龙的「领取每日奖励」要求当天委托已完成，而 BetterGI 的一条龙**没有委托任务**，
  //    所以顺序必须是：先跑委托配置组（JS 脚本做委托），再跑一条龙领奖励。
  //    BetterGI 的命令行支持 `BetterGI.exe --startGroups <组名>`（官方源码 CommandLineOptions.cs）。
  //
  //    跑两遍的情况：委托是每天轮换的，脚本第一天只会把「今天的委托」记进账号配置，
  //    流程文件是跑之前补的 —— 所以第一遍会报「未找到委托 X 在 Y 的流程」。
  //    这时补出流程再跑一遍就能把委托做完（第一遍至少把名字/地点/坐标记下来了）。
  const groupBudgetMin = Math.min(Math.max(10, Number(args.timeoutMin) || 60), 45);
  let groupText = '';
  const runGroups = async (budgetMin) => {
    const groupReader = createLogReader(args.root);
    groupReader.read();
    const groupChild = spawn(exe, ['--startGroups', ...args.groups], {
      cwd: args.root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    groupChild.stdout.on('data', (chunk) => process.stdout.write(chunk));
    groupChild.stderr.on('data', (chunk) => process.stderr.write(chunk));
    let childExited = false;
    groupChild.on('exit', () => {
      childExited = true;
    });
    const deadline = Date.now() + budgetMin * 60 * 1000;
    let done = false;
    let text = '';
    let lastGrow = Date.now();
    while (Date.now() < deadline) {
      await sleep(5000);
      const chunk = groupReader.read();
      if (chunk) {
        text += chunk;
        lastGrow = Date.now();
      }
      if (GROUP_DONE_MARKERS.some((marker) => text.includes(marker))) {
        done = true;
        break;
      }
      // 进程已经退出、日志也不再增长 → 没有活着的实例在跑（崩溃/被掐掉/游戏退出）。
      // 再等下去就是白烧预算：BetterGI 的单实例会把命令行参数转发给老实例就退出，
      // 所以给 3 分钟的宽限，让新实例把日志写出来。
      if (childExited && Date.now() - lastGrow > 3 * 60 * 1000) {
        log('配置组进程已退出且日志不再增长（没有实例在跑），提前结束这一遍');
        break;
      }
    }
    // 注意是**累加**：补跑那一遍只会重新打失败的那条委托，
    // 成功过的委托不会再来一遍 —— 直接覆盖会把之前那些「委托执行成功」行弄丢，
    // 报告里就少了委托步骤（实测 2026-11-05：报告里只剩 自动秘境/尘歌壶/每日奖励）。
    groupText += text;
    // BetterGI 的单实例会让第二次命令行参数只做转发、不真正执行，
    // 所以这里要结束 BetterGI（游戏留着不关），再起新的实例。
    try {
      killBettergi();
    } catch {
      /* ignore */
    }
    await sleep(3000);
    return done;
  };

  if (args.groups.length) {
    log(`先跑配置组：${args.groups.join('、')}`);
    const groupDone = await runGroups(groupBudgetMin);
    if (groupDone) log(`配置组完成：${args.groups.join('、')}`);
    else log(`配置组 ${args.groups.join('、')} 在预算内没有出现收尾标记，继续跑一条龙（委托可能没做完）`);

    // 趁脚本刚识别完委托，把流程补出来：
    //   ① 今天的委托缺流程 → 补完再跑一遍（今天就能做完）
    //   ② 今天的委托做完了 → 这些流程留着给明天用（省得明天又卡一次）
    const heal = () => {
      try {
        // 从刚才这遍的日志里认出每个委托是战斗还是采集 —— 委托每天轮换，
        // 类型只能从游戏自己的委托描述里看（「击败所有敌人0/3」= 战斗，
        // 「收集所有[冰]元素微粒0/1」= 采集），硬编码必然对不上。
        // 认过一次就记住（同名委托的类型是固定的），第二天直接用对的流程。
        const learned = parseCommissionTypes(groupText);
        const types = args.stateDir
          ? saveCommissionTypes(args.stateDir, learned)
          : { ...loadCommissionTypes(''), ...learned };
        const flows = ensureCommissionFlows(args.root, PLUGIN_ROOT, { types });
        log(
          `委托流程自愈：${JSON.stringify({
            ok: flows.ok,
            flows: flows.flows,
            discovered: flows.discovered,
            types,
            changed: (flows.changed || []).length,
            error: flows.error || '',
          })}`,
        );
        return flows;
      } catch (error) {
        log(`委托流程自愈失败：${String((error && error.message) || error)}`);
        return { ok: false };
      }
    };
    const flows = heal();
    // 重跑的条件：委托没做完就别放弃。
    //   · 「未找到委托」  → 今天的委托还没有流程（第一遍只是把名字/坐标记下来了）
    //   · 「执行后检查未完成」→ 流程跑了但委托没达成（常见于流程坐标是昨天的旧坐标）
    // 两种情况都能靠「补流程 + 再跑一遍」解决。
    const needRetry = /未找到委托|执行后检查未完成|仍未完成，跳过该委托|委托执行失败/.test(groupText);
    if (needRetry && flows.ok) {
      log('检测到委托缺流程（今天的委托是轮换的），补录后重跑一次配置组');
      const again = await runGroups(Math.min(groupBudgetMin, 30));
      log(again ? '重跑完成' : '重跑仍未出现收尾标记');
      heal();
    }
  }

  // 3) 跑一条龙（冷启动会自己拉起游戏）
  const reader = createLogReader(args.root);
  log(`开始一条龙：startOneDragon ${args.config}（BetterGI 会自行拉起游戏）`);
  const child = spawn(exe, ['startOneDragon', args.config], { cwd: args.root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  let finished = false;
  let collected = '';
  const finish = (code, reason) => {
    if (finished) return;
    finished = true;
    clearInterval(watchdog);
    collected += reader.read();
    if (reason) log(reason);
    try {
      killBettergi();
    } catch {
      /* ignore */
    }
    const report = bettergiReport({
      gameId: args.gameId,
      mode: args.mode,
      runId: args.runId,
      exitCode: code == null ? -1 : code,
      startedAt,
      // 前置配置组（每日委托）的日志要一起给报告解析：
      // 委托是在一条龙之前跑的，它的日志行在文件里更早，
      // 而一条龙这段的读取器是从「当前文件末尾」开始收的（只收新增）——
      // 不拼上 groupText，报告里就没有「每日委托 · XXX」这些步骤。
      logText: [groupText, collected].filter(Boolean).join('\n'),
    });
    process.stdout.write(`##REPORT ${JSON.stringify(report)}\n`);
    process.exit(0);
  };

  const timeoutMs = Math.max(10, Number(args.timeoutMin) || 60) * 60 * 1000;
  const watchdog = setInterval(() => {
    collected += reader.read();
    if (collected.includes(DONE_MARKER)) finish(0, '检测到一条龙收尾标记');
    else if (Date.now() - started > timeoutMs) finish(-1, `超过 ${args.timeoutMin || 60} 分钟仍未收尾，放弃等待`);
  }, 5000);

  child.on('error', (error) => {
    log(`启动失败：${String((error && error.message) || error)}`);
    finish(-1, 'BetterGI 启动失败');
  });
  child.on('exit', (code) => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    collected += reader.read();
    if (!collected.includes(DONE_MARKER) && elapsed < 300) {
      // BetterGI 冷启动会**提权重启自己**（父进程退出码 553），真正在跑一条龙的是新实例。
      // 早先这里直接 finish + killBettergi()，等于把正在跑的日常自己掐死，还报 failed。
      // 现在改成继续盯日志，最多再等 5 分钟收尾标记。
      log(`进程 ${elapsed}s 就退出（code=${code}）且没有收尾标记 —— 多半是 BetterGI 提权重启了自己，继续等新实例写日志。`);
      setTimeout(() => {
        if (finished) return;
        collected += reader.read();
        if (!collected.includes(DONE_MARKER)) finish(code, 'BetterGI 退出后 5 分钟内没有收尾标记');
      }, 5 * 60 * 1000);
      return;
    }
    finish(code, 'BetterGI 进程已退出');
  });
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
