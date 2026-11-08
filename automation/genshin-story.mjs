#!/usr/bin/env node
/**
 * automation/genshin-story.mjs — 原神「主线剧情」跑批器（BetterGI + AutoStoryLoader）。
 *
 * 背景：BetterGI 官方仓库里的 AutoStoryLoader（自动剧情加载器，作者 星野）提供了一套
 * 流程框架，指令集 = 地图追踪(跑图) / 对话(自动跳过) / 战斗 / 键鼠脚本 / 按键 / 暂停。
 * 框架本身公开，但**每个章节的路线文件（*.json 跑图路线）作者只在 BadGI 交流群发放**，
 * 官方仓库里只有 process.json（流程驱动文件）。
 *
 * 这个脚本负责：
 *   ① 体检/安装 AutoStoryLoader（缺就从官方仓库补齐）
 *   ② 装路线包（--pack zip|目录）到 User\JsScript\AutoStoryLoader\process\<章节>\
 *   ③ 列出本机已有章节 + 每个章节**缺哪些路线文件**（照着补包就行）
 *   ④ 建 BetterGI 配置组「主线剧情」（Javascript 项目 + jsScriptSettingsObject）
 *   ⑤ --run 时真跑：BetterGI.exe --startGroups 主线剧情；脚本「暂停」时发系统通知提醒你
 *
 * 用法：
 *   node automation/genshin-story.mjs --list                 # 列出章节 + 缺哪些路线
 *   node automation/genshin-story.mjs --pack D:\下载\routes.zip --list
 *   node automation/genshin-story.mjs --setup --process "馋馋你们-6.0主线 第二章 尘与灯的挽歌"
 *   node automation/genshin-story.mjs --run --process "..." --timeout-min 90
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { notify } from '../lib/notify.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_NAME = 'AutoStoryLoader';
const GROUP_NAME = '主线剧情';
const REPO_RAW = 'https://raw.githubusercontent.com/babalae/bettergi-scripts-list/main/repo/js/AutoStoryLoader';
const REPO_CDN = 'https://cdn.jsdelivr.net/gh/babalae/bettergi-scripts-list@main/repo/js/AutoStoryLoader';
const REPO_LIST = 'https://data.jsdelivr.com/v1/packages/gh/babalae/bettergi-scripts-list@main?structure=flat';

const MARK_START = '开始自动剧情';
const MARK_PAUSE = '即将暂停脚本的运行';
const MARK_DONE = '一条龙和配置组任务结束';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => process.stdout.write(`[story] ${text}\n`);

function parseArgs(argv) {
  const out = { packs: [], run: false, list: false, setup: false, timeoutMin: 90, process: '', team: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--state-dir') out.stateDir = argv[++i];
    else if (a === '--pack') out.packs.push(argv[++i]);
    else if (a === '--process') out.process = argv[++i];
    else if (a === '--team') out.team = argv[++i];
    else if (a === '--timeout-min') out.timeoutMin = Number(argv[++i]) || out.timeoutMin;
    else if (a === '--run') out.run = true;
    else if (a === '--list') out.list = true;
    else if (a === '--setup') out.setup = true;
  }
  out.root = out.root || process.env.DSH_GAME_DAILY_BETTERGI_ROOT || 'D:\\software\\BetterGI';
  out.stateDir = out.stateDir || path.join(os.homedir(), '.dsh', 'game-daily');
  return out;
}

function bettergiLogFile(root) {
  const logDir = path.join(root, 'log');
  const files = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter((f) => f.startsWith('better-genshin-impact') && f.endsWith('.log'))
    : [];
  if (!files.length) return '';
  files.sort();
  return path.join(logDir, files[files.length - 1]);
}

function killBettergi() {
  try {
    execFileSync('taskkill.exe', ['/F', '/IM', 'BetterGI.exe'], { windowsHide: true, timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

/** 官方仓库里的 AutoStoryLoader 文件清单（jsDelivr 索引）。 */
async function fetchRepoFileList() {
  const resp = await fetch(REPO_LIST, { headers: { 'User-Agent': 'dsh-game-daily' } });
  const json = await resp.json();
  const prefix = '/repo/js/AutoStoryLoader/';
  return (json.files || [])
    .map((f) => f.name)
    .filter((n) => n.startsWith(prefix))
    .map((n) => n.slice(prefix.length));
}

/** 缺脚本就补齐（只补代码/配置，不碰 process/ 里的流程文件）。 */
async function ensureScriptInstalled(root) {
  const dir = path.join(root, 'User', 'JsScript', SCRIPT_NAME);
  const mainJs = path.join(dir, 'main.js');
  if (fs.existsSync(mainJs) && fs.existsSync(path.join(dir, 'manifest.json'))) {
    return { ok: true, dir, installed: false };
  }
  let files = [];
  try {
    files = await fetchRepoFileList();
  } catch (error) {
    return { ok: false, dir, error: `拿不到官方文件清单：${String((error && error.message) || error)}` };
  }
  if (!files.length) return { ok: false, dir, error: '官方仓库里没找到 AutoStoryLoader 文件' };
  let saved = 0;
  for (const rel of files) {
    if (rel.startsWith('process/')) continue; // 流程文件由路线包提供
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const body = await fetch(`${REPO_RAW}/${rel}`).then((r) => (r.ok ? r.text() : null));
    const text = body ?? (await fetch(`${REPO_CDN}/${rel}`).then((r) => (r.ok ? r.text() : null)));
    if (text == null) continue;
    fs.writeFileSync(dest, text, 'utf8');
    saved += 1;
  }
  return { ok: fs.existsSync(mainJs), dir, installed: true, saved };
}

/** 章节列表：process 目录下所有 process.json → 选项名（目录路径用 - 连接）+ 引用到的路线文件。 */
function listChapters(root) {
  const processDir = path.join(root, 'User', 'JsScript', SCRIPT_NAME, 'process');
  const out = [];
  if (!fs.existsSync(processDir)) return out;
  const walk = (dir, parts) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, [...parts, name]);
      else if (name === 'process.json') {
        const text = fs.readFileSync(full, 'utf8');
        const refs = [];
        // 新格式：「地图追踪 x.json」/「键鼠脚本 x.json」；旧格式：整行就是 x.json
        const re = /^\s*(?:(?:地图追踪|键鼠脚本)\s+)?([^\s#]+\.json)\s*$/gm;
        let m = re.exec(text);
        while (m) {
          if (m[1] !== 'process.json') refs.push(m[1]);
          m = re.exec(text);
        }
        out.push({
          option: parts.join('-'),
          dir: path.dirname(full),
          file: full,
          refs: [...new Set(refs)],
          pauses: (text.match(/^\s*暂停/gm) || []).length,
          steps: text.split(/\r?\n/).filter((l) => l.trim()).length,
        });
      }
    }
  };
  walk(processDir, []);
  return out;
}

/** 某个章节缺哪些路线文件。 */
function missingRefs(chapter) {
  const have = new Set(fs.readdirSync(chapter.dir));
  return chapter.refs.filter((r) => !have.has(r));
}

/** 装路线包：zip 用 tar 解，目录直接拷。 */
function installPack(packPath, root) {
  const processDir = path.join(root, 'User', 'JsScript', SCRIPT_NAME, 'process');
  fs.mkdirSync(processDir, { recursive: true });
  const result = { pack: packPath, ok: false, copied: [], error: '' };
  if (!fs.existsSync(packPath)) {
    result.error = '路线包不存在';
    return result;
  }
  const isZip = /\.zip$/i.test(packPath);
  let source = packPath;
  if (isZip) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bgi-story-'));
    try {
      execFileSync('tar', ['-xf', packPath, '-C', tmp], { windowsHide: true, timeout: 120000 });
      source = tmp;
    } catch (error) {
      result.error = `解压失败：${String((error && error.message) || error)}`;
      return result;
    }
  }
  // 包里通常有 process/<章节>/... 或直接是章节内容
  const nested = path.join(source, 'process');
  const base = fs.existsSync(nested) ? nested : source;
  for (const entry of fs.readdirSync(base)) {
    const full = path.join(base, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    const dest = path.join(processDir, entry);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(full)) {
      const from = path.join(full, f);
      if (!fs.statSync(from).isFile()) continue;
      fs.copyFileSync(from, path.join(dest, f));
      result.copied.push(path.join(entry, f));
    }
  }
  result.ok = result.copied.length > 0;
  if (!result.ok) result.error = '包里没找到章节目录';
  return result;
}

/** 建/更新 BetterGI 配置组「主线剧情」。 */
function ensureGroup(root, { processName, team }) {
  const dir = path.join(root, 'User', 'ScriptGroup');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${GROUP_NAME}.json`);
  const group = {
    index: 99,
    name: GROUP_NAME,
    config: { enableShellConfig: false },
    projects: [
      {
        name: `${SCRIPT_NAME}.js`,
        folderName: SCRIPT_NAME,
        jsScriptSettingsObject: {
          disclaimer_accepted: true,
          disclaimer_confirm_text: '同意',
          process_selector: processName,
          team: team || '',
          elementTeam: '',
          pause: '',
          noSkip: false,
          noEat: false,
        },
        index: 0,
        type: 'Javascript',
        status: 'Enabled',
        schedule: 'Daily',
        runNum: 1,
        allowJsNotification: true,
        allowJsHTTPHash: '',
      },
    ],
  };
  if (fs.existsSync(file)) {
    const backup = `${file}.bak-story-${Date.now()}`;
    fs.copyFileSync(file, backup);
    group.backup = backup;
  }
  fs.writeFileSync(file, `${JSON.stringify(group, null, 2)}\n`, 'utf8');
  return { ok: true, file, backup: group.backup || '' };
}

/** 盯日志：开始 / 暂停（通知用户）/ 收尾。 */
async function runGroup(root, { timeoutMin, processName, stateDir }) {
  const exe = path.join(root, 'BetterGI.exe');
  if (!fs.existsSync(exe)) return { ok: false, error: `找不到 ${exe}` };
  const logFile = bettergiLogFile(root);
  if (!logFile) return { ok: false, error: '找不到 BetterGI 日志文件' };

  if (killBettergi()) await sleep(3000);

  const child = spawn(exe, ['--startGroups', GROUP_NAME], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => process.stdout.write(c));
  child.stderr.on('data', (c) => process.stderr.write(c));

  let size = 0;
  try {
    size = fs.statSync(logFile).size;
  } catch {
    /* ignore */
  }
  const readNew = () => {
    try {
      const stat = fs.statSync(logFile);
      if (stat.size <= size) return '';
      const fd = fs.openSync(logFile, 'r');
      const buf = Buffer.alloc(stat.size - size);
      fs.readSync(fd, buf, 0, buf.length, size);
      fs.closeSync(fd);
      size = stat.size;
      return buf.toString('utf8');
    } catch {
      return '';
    }
  };

  const started = Date.now();
  const deadline = started + timeoutMin * 60 * 1000;
  let text = '';
  let startedSeen = false;
  let paused = 0;
  let done = false;
  let lastGrow = started;

  while (Date.now() < deadline) {
    await sleep(3000);
    const chunk = readNew();
    if (chunk) {
      text += chunk;
      lastGrow = Date.now();
      if (!startedSeen && text.includes(MARK_START)) {
        startedSeen = true;
        log(`剧情流程开始：${processName}`);
      }
      const pauseCount = text.split(MARK_PAUSE).length - 1;
      if (pauseCount > paused) {
        paused = pauseCount;
        const hint = (text.match(/作者提示：(.+)/g) || []).slice(-1)[0] || '';
        notify({
          stateDir,
          title: '原神主线：脚本暂停了',
          body: `需要你手动处理一下：${hint.replace('作者提示：', '').trim() || '按提示在游戏里操作，10 秒后自动继续'}`,
        });
        log(`脚本暂停（第 ${paused} 次），已发通知`);
      }
      if (text.includes(MARK_DONE)) {
        done = true;
        break;
      }
    }
    if (child.exitCode !== null && Date.now() - lastGrow > 60 * 1000) break;
  }
  try {
    killBettergi();
  } catch {
    /* ignore */
  }
  return { ok: done, done, paused, started: startedSeen, text, logFile };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const install = await ensureScriptInstalled(args.root);
  if (!install.ok) {
    log(`AutoStoryLoader 不可用：${install.error || '未知原因'}`);
    process.exitCode = 1;
    return;
  }
  if (install.installed) log(`已补装 AutoStoryLoader（${install.saved} 个文件）`);

  const packs = args.packs.map((p) => installPack(p, args.root));
  for (const p of packs) {
    log(p.ok ? `路线包已装：${p.copied.length} 个文件（${p.packed || p.pack}）` : `路线包失败：${p.error}`);
  }

  const chapters = listChapters(args.root);
  const report = { chapters: [], missing: {}, group: null, run: null };
  for (const c of chapters) {
    const missing = missingRefs(c);
    report.chapters.push({
      option: c.option,
      steps: c.steps,
      pauses: c.pauses,
      refs: c.refs.length,
      missing,
      ready: c.refs.length > 0 && missing.length === 0,
    });
    report.missing[c.option] = missing;
  }

  if (args.list || (!args.run && !args.setup)) {
    log('章节清单（option = 配置组里 process_selector 的值）：');
    for (const c of report.chapters) {
      const mark = c.ready ? '✅ 路线齐全' : `⚠️ 缺 ${c.missing.length} 个路线文件`;
      log(`  · ${c.option}  [${c.steps} 步 / ${c.pauses} 个暂停 / 引用 ${c.refs} 个路线] ${mark}`);
      if (c.missing.length) for (const m of c.missing) log(`      缺: ${m}`);
    }
    if (!report.chapters.length) log('  （process/ 下还没有任何章节流程）');
  }

  const chosen = args.process || (report.chapters.find((c) => c.ready) || report.chapters[report.chapters.length - 1] || {}).option || '';
  if (args.setup || args.run) {
    if (!chosen) {
      log('没有可用章节（先装路线包，或用 --process 指定）');
      process.exitCode = 1;
    } else {
      report.group = ensureGroup(args.root, { processName: chosen, team: args.team });
      log(`配置组已就绪：${report.group.file}（process_selector=${chosen}）`);
    }
  }

  if (args.run && chosen) {
    const r = await runGroup(args.root, {
      timeoutMin: args.timeoutMin,
      processName: chosen,
      stateDir: args.stateDir,
    });
    report.run = { ok: r.ok, done: r.done, paused: r.paused, started: r.started, error: r.error || '' };
    log(r.done ? '主线流程收尾完成' : `主线流程未收尾（${r.error || '超时或中断'}）`);
    process.stdout.write(`##REPORT ${JSON.stringify(report)}\n`);
    process.exitCode = r.done ? 0 : 1;
    return;
  }

  process.stdout.write(`##REPORT ${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error && error.stack) || String(error)}\n`);
  process.exit(1);
});
