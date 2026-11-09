// 「每日委托」社区脚本的流程自愈。
//
// 背景：BetterGI 官方没有每日委托任务（一条龙里没有），社区脚本 AutoCommissionNova
// 负责做委托，但它自带的 process/ 流程目录只有蒙德(NPC) 与 须弥(Basic) ——
// 账号在至冬·古兽冰原，委托能识别出来，却因为找不到流程而执行不了：
//   「未找到委托 "邪恶的扩张" 在 "古兽冰原" 的流程」
//
// 脚本更新会把 process/ 和 config/commission-catalog.json 覆盖回上游版本，
// 所以补录的流程要能自动补回来（就像 M7A 的体力计划那样）。
import fs from 'node:fs';
import path from 'node:path';

const FLOW_FILE = 'commission-flows.json';

/** 默认补录清单（automation/commission-flows.json 可覆盖）。 */
export function defaultCommissionFlows() {
  return {
    script: 'AutoCommissionNova',
    battleStrategy: '万能战斗策略（萌新推荐）',
    flows: [
      { name: '邪恶的扩张', country: '至冬', location: '古兽冰原', collect: false, points: [[7575, 7768]] },
      { name: '为雪不净', country: '至冬', location: '古兽冰原', collect: false, points: [[7173, 7866], [7127, 7996]] },
      { name: '霜冰收藏家', country: '至冬', location: '古兽冰原', collect: true, points: [[7942, 8015]] },
    ],
  };
}

/**
 * 从 BetterGI 日志里认出每个委托是「战斗」还是「采集」。
 *
 * 委托脚本在检查完成状态时会 OCR 委托描述，日志里有好几处：
 *   第一行仍为委托名称，使用第二行描述: "击败所有敌人0/3"
 *   OCR结果稳定: "击败所有敌人0/4"
 *   步骤 desc 不匹配，跳过步骤。识别："摧毁丘丘人哨塔0/2", 期望包含："采集"
 * 描述里带「击败/摧毁/击破」就是战斗委托，带「收集/采集/元素微粒」就是采集委托。
 *
 * 为什么要认：两种委托的走法完全不同 ——
 *   · 战斗：走到敌人附近 → 自动战斗打怪
 *   · 采集：跑一圈 + 下落攻击把元素微粒捡起来（下落攻击在战斗委托里是多余的，
 *     还会打断战斗节奏）
 * 委托每天轮换，硬编码类型必然对不上，只能从游戏自己的日志里认。
 *
 * @param {string} logText BetterGI 日志（增量）
 * @returns {Record<string, 'combat'|'collect'>}
 */
export function parseCommissionTypes(logText) {
  const counts = {};
  let current = '';
  const classify = (name, text) => {
    if (!name || !text) return;
    const value = String(text);
    const type = /击败|消灭|摧毁|击破|讨伐|歼灭|清除|破坏/.test(value)
      ? 'combat'
      : /收集|采集|元素微粒|拾取/.test(value)
        ? 'collect'
        : '';
    if (!type) return;
    if (!counts[name]) counts[name] = { combat: 0, collect: 0 };
    counts[name][type] += 1;
  };
  for (const raw of String(logText || '').split(/\r?\n/)) {
    const line = raw.replace(/^.*?\]:\s*/, '').trim();
    // 「执行委托：X | 地区 | Basic | 第 1/2 次」是**一次尝试的开头**，
    // 后面这一整段日志（寻路、战斗、OCR 描述）都属于这个委托。
    // 用它来定位描述属于谁 —— 用「找到委托」定位会串台：
    // 一个委托的描述是在它自己的「在附近交互」步骤里 OCR 的，
    // 那时日志里可能已经出现了下一个委托的「找到委托」。
    const attempt = /执行委托[：:]\s*([^ |｜]+)/.exec(line);
    if (attempt) {
      current = attempt[1].trim();
      continue;
    }
    const desc =
      /步骤 desc 不匹配[^\n]*?识别[：:]\s*[“"「]?([^"”」，,、]+)/.exec(line) ||
      /OCR结果稳定[：:]\s*[“"「]?([^"”》，,、]+)/.exec(line) ||
      /使用第二行描述[：:]\s*[“"「]?([^"”」，,、]+)/.exec(line) ||
      /OCR结果[：:]\s*[“"「]?([^"”》，,、]+)/.exec(line);
    if (desc) classify(current, desc[1]);
  }
  // 同一委托被认成两种类型时取出现次数多的；一样多时按「战斗」算 ——
  // 战斗型流程短、已被实测跑通，认错成采集型会白绕一大圈还可能把怪甩出战斗范围。
  const types = {};
  for (const [name, row] of Object.entries(counts)) {
    types[name] = row.collect > row.combat ? 'collect' : 'combat';
  }
  return types;
}

/**
 * 委托流程步骤。
 *
 * 战斗型：自动任务(AutoPick) → 地图追踪 → 自动战斗 → 在附近交互(desc=收集)
 * 采集型：自动任务(AutoPick) → 地图追踪 → 在附近交互(desc=收集)
 *
 * 关键实测结论：
 * 1. 采集型**不能**带「自动战斗」：原神 60 秒的自动战斗会让角色到处跑
 *    （实测：战斗一结束，角色已经离开冰块，「F ⚙ 进入」的提示早没了，
 *    后面的「在附近交互」当然找不到）。
 * 2. 「在附近交互」的 `desc` 是脚本自己的关键词匹配（委托描述.includes(desc)）：
 *    采集委托的描述是「收集所有[冰]元素微粒」—— 用「采集」匹配不上（收集≠采集），
 *    整步会被静默跳过，委托永远差最后一步。所以写「收集」。
 * 3. 战斗型也保留「在附近交互」这一步：它会因为 desc 不匹配被**跳过**（不是失败，
 *    不中断流程），而它的 desc 检查过程会把委托描述 OCR 出来打进日志 ——
 *    于是两种委托都能从日志里认出类型（见 parseCommissionTypes）。
 * 4. **绝对不能出现 `up_down_grab_leaf`**（见 pathFile 的注释）：那是须弥四叶印（悬空踏板）
 *    专用动作，至冬根本没有四叶印，带上就是死循环「没有找到四叶印」。
 */
export function flowSteps(flow) {
  const steps = [];
  // 官方「愿风带走思念」采集蒲公英籽的同一套范式：开自动拾取，元素微粒掉了会自动捡。
  steps.push({ type: '自动任务', data: { action: 'enable', taskType: 'AutoPick' } });
  steps.push({ type: '地图追踪', data: '_path.json' });
  // 只有战斗型才打怪；采集型打了也没怪，还会把角色带跑（见结论 1）。
  if (flow.collect === false) {
    steps.push({ type: '自动战斗', data: { timeout: 60 } });
  }
  steps.push({
    type: '在附近交互',
    desc: flow.interactDesc || '收集',
    data: { text: flow.interactText || '进入', turns: Number(flow.interactTurns) || 3 },
  });
  return steps;
}

function readFlowConfig(pluginRoot) {
  try {
    const raw = fs.readFileSync(path.join(pluginRoot, 'automation', FLOW_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.flows) && parsed.flows.length) return parsed;
  } catch {
    /* ignore */
  }
  return defaultCommissionFlows();
}

/**
 * 一条委托流程的路径文件（BetterGI 路径追踪格式）。
 *
 * 采集类委托（「跑图收集元素力」）不是站在一个点就能完成的：
 * 元素微粒散落在委托点周围，要**跑一圈**才能都捡到。
 * 官方的须弥采集委托流程就是「[地图追踪] 一步 + 一条十几个点的路径」，
 * 路径点带 `up_down_grab_leaf`（下落攻击采集）动作，捡到的同时 AutoPick 也会顺手拾取。
 * 所以这里生成一个以委托坐标为中心的**环形路径**（默认 8 个点、半径 20 米），
 * 每个点都带采集动作 —— 相当于把官方的「跑图」补出来。
 */
function pathFile(flow, x, y) {
  const now = Date.now();
  // 采集委托的圈要小：提示（"F ⚙ 进入"）只在采集点旁边几米内才出现，
  // 绕太远就看不到提示了，后面的「在附近交互」自然就找不到。
  const radius = Number(flow.radius) > 0 ? Number(flow.radius) : 10;
  const count = Number(flow.loopPoints) > 0 ? Number(flow.loopPoints) : 4;
  const positions = [
    // teleport = 传送点，BetterGI 会吸附到离它最近的传送锚点
    { action: '', action_params: '', id: 1, move_mode: 'walk', type: 'teleport', x, y },
    // 第一个路点**不能带动作**：带动作的路点要先找到「四叶印」才肯走，
    // 而四叶印只有在走到跟前才看得见 —— 传送完就带动作会卡死
    // （日志里表现为一直「尝试寻找 "四叶印" / 没有找到四叶印」）。
    // 官方流程也是这么写的：传送之后第一个路点 action 为空。
    { action: '', action_params: '', id: 2, locked: false, move_mode: 'walk', type: 'path', x, y },
  ];
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    positions.push({
      // **不带采集动作**：带 `up_down_grab_leaf` 的路点要先找到「四叶印」才肯走，
      // 而四叶印只在游戏里真实存在的采集点才有 —— 自己编的环形路径永远找不到，
      // 表现就是死循环「尝试寻找 "四叶印" / 没有找到四叶印」。
      // 走过去就行：AutoPick 会顺手把地上的元素微粒拾起来。
      action: '',
      action_params: '',
      id: i + 3,
      locked: false,
      move_mode: 'walk',
      type: 'path',
      x: Number((x + Math.cos(angle) * radius).toFixed(2)),
      y: Number((y + Math.sin(angle) * radius).toFixed(2)),
    });
  }
  return {
    info: {
      authors: [{ links: '', name: 'dsh-game-daily' }],
      bgi_version: '0.66.0',
      description: `${flow.country}-${flow.location}-${flow.name}（插件补录）`,
      enable_monster_loot_split: false,
      last_modified_time: now,
      map_match_method: '',
      map_name: 'Teyvat',
      name: `${flow.country}-${flow.location}-${flow.name}`,
      tags: [],
      type: 'collect',
      version: '1.0',
    },
    positions,
  };
}

/**
 * 战斗委托的路径文件。
 *
 * 照抄官方流程的形状（如 `process\蒙德\Basic\固若金汤\龙脊雪山-1\_path.json`）：
 * 传送 → 走到目标点 → **在目标点按 F 触发战斗** → 收尾。
 *
 * 官方那条流程的关键一步是
 *   { "type": "target", "action": "combat_script", "action_params": "w(0.1),wait(1.3),keypress(F)" }
 * —— 走到地方后按一下 F（交互键）才会开始打；
 * 插件原来只走到点就开打，委托一直判定「未完成」。
 *
 * 其它要点：
 *   · 不带采集动作（下落攻击）—— 那是采集委托才需要的，在战斗委托里只会打断节奏；
 *   · 敌人具体在哪由后面的「自动战斗」自己找过来。
 */
function combatPathFile(flow, x, y) {
  const now = Date.now();
  const positions = [
    { action: '', action_params: '', id: 1, move_mode: 'walk', type: 'teleport', x, y },
    { action: '', action_params: '', id: 2, locked: false, move_mode: 'walk', type: 'target', x, y },
    {
      action: 'combat_script',
      action_params: 'w(0.1),wait(1.3),keypress(F)',
      id: 3,
      locked: false,
      move_mode: 'walk',
      type: 'target',
      x,
      y,
    },
  ];
  return {
    info: {
      authors: [{ links: '', name: 'dsh-game-daily' }],
      bgi_version: '0.66.0',
      description: `${flow.country}-${flow.location}-${flow.name}（插件补录·战斗）`,
      enable_monster_loot_split: false,
      last_modified_time: now,
      map_match_method: '',
      map_name: 'Teyvat',
      name: `${flow.country}-${flow.location}-${flow.name}`,
      tags: [],
      type: 'collect',
      version: '1.0',
    },
    positions,
  };
}

/**
 * 这个流程文件是不是插件自己生成的？
 *
 * 插件生成的路径文件里 authors[0].name = 'dsh-game-daily'。
 * 上游（babalae/bettergi-scripts-list）手录的流程没有这个标记 ——
 * **那些不能覆盖**：上游的流程是真人跑出来的路线（敌人具体在哪、怎么走过去），
 * 插件用「委托坐标 + 环形」生成的通用路线比它差很多。
 * 2026-11-04 实测：蒙德/Basic/大病初愈 被覆盖成环形路线后，
 * 角色在蒙德城里绕着一个点打转（「疑似卡死」），委托做不完。
 */
function isPluginGeneratedFlow(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return /"name"\s*:\s*"dsh-game-daily"/.test(text);
  } catch {
    return false;
  }
}

function writeIfChanged(file, content) {
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保补录的流程还在（脚本更新后会被覆盖，这里补回来）。
 *
 * 除了固定清单，还会**按脚本存下来的当天委托自动生成流程**：
 * 脚本每次识别完委托，都会把「名称 / 地区 / 地点 / 坐标」写进账号配置的
 * `commissions` 数组（Data/user-config/<uid>.json）。
 * 每日委托是轮换的（今天这四个明天就换），硬编码清单必然覆盖不全，
 * 所以这里直接用这份数据生成流程 —— 坐标就是脚本自己 OCR 出来的，路径终点天然对得上。
 *
 * @param {string} bettergiRoot BetterGI 安装目录
 * @param {string} pluginRoot 插件根目录（读 commission-flows.json）
 */
/**
 * 委托类型记忆：<stateDir>/automation/commission-types.json
 *
 * 委托每天轮换，但**同一个名字的委托类型是固定的**（「为雪不净」永远是战斗型，
 * 「霜冰收藏家」永远是采集型）。认过一次就记住，第二天不用再猜。
 */
export function commissionTypesPath(stateDir) {
  return path.join(stateDir, 'automation', 'commission-types.json');
}

/** 读出记住的类型；新学到的类型合并进去并落盘。 */
export function loadCommissionTypes(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(commissionTypesPath(stateDir), 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    /* ignore */
  }
  return {};
}

/** 把新学到的类型并进记忆（同名以新值为准），返回合并后的类型表。 */
export function saveCommissionTypes(stateDir, learned = {}) {
  const current = loadCommissionTypes(stateDir);
  const merged = { ...current };
  let changed = false;
  for (const [name, type] of Object.entries(learned || {})) {
    if (!name || (type !== 'combat' && type !== 'collect')) continue;
    if (merged[name] !== type) {
      merged[name] = type;
      changed = true;
    }
  }
  if (changed) {
    try {
      fs.mkdirSync(path.dirname(commissionTypesPath(stateDir)), { recursive: true });
      fs.writeFileSync(commissionTypesPath(stateDir), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    } catch {
      /* ignore */
    }
  }
  return merged;
}

export function ensureCommissionFlows(bettergiRoot, pluginRoot, { types = {} } = {}) {
  const config = readFlowConfig(pluginRoot);
  const scriptDir = path.join(bettergiRoot, 'User', 'JsScript', config.script);
  if (!fs.existsSync(scriptDir)) {
    return { ok: false, skipped: 'not-installed', error: `没有找到脚本目录：${scriptDir}` };
  }
  const changed = [];
  const skipped = [];
  const now = Date.now();

  // 1) 账号配置：关掉「先传送到神像」（会把角色传到当前地区神像，然后走不到位冬的委托点），
  //    指定战斗策略，并读取脚本存下来的当天委托。
  const userConfigDir = path.join(scriptDir, 'Data', 'user-config');
  let accounts = [];
  try {
    accounts = fs
      .readdirSync(userConfigDir)
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => path.join(userConfigDir, name));
  } catch {
    /* 还没生成账号配置：等脚本第一次跑完才会有 */
  }
  const discovered = [];
  for (const file of accounts) {
    try {
      const account = JSON.parse(fs.readFileSync(file, 'utf8'));
      account.settings = account.settings || {};
      account.settings.skipSafeTeleport = true;
      // 历练点优先：官方脚本自带这个开关（true = 先领历练点奖励，再按「每日委托奖励 n/4」
      // 判断还差几条，只做缺的）。没有历练点时脚本会按原流程跑图+战斗，正好是兜底。
      account.settings.checkEncounterPoints = true;
      account.settings.party = account.settings.party || { global: {}, scopes: {} };
      account.settings.party.global = {
        ...(account.settings.party.global || {}),
        battleStrategy: config.battleStrategy || '根据队伍自动选择',
      };
      fs.writeFileSync(file, `${JSON.stringify(account, null, 4)}\n`, 'utf8');
      changed.push(file);
      // 收集当天委托（名字 / 地区 / 地点 / 坐标）
      for (const item of Array.isArray(account.commissions) ? account.commissions : []) {
        const pos = item && item.commissionPosition;
        if (!item || !item.name || !item.country || !item.location || !pos) continue;
        if (!Number.isFinite(Number(pos.X)) || !Number.isFinite(Number(pos.Y))) continue;
        discovered.push({
          name: String(item.name),
          country: String(item.country),
          location: String(item.location),
          // 默认按战斗型处理（类型认出来之后会用日志里的判断覆盖）：
          // 战斗型流程「走到目标点 + 按 F + 自动战斗」对采集型也能兜住，
          // 反过来（默认采集型的环形路径）会让战斗委托在原地绕圈打转。
          collect: false,
          points: [[Number(pos.X), Number(pos.Y)]],
        });
      }
    } catch {
      /* ignore */
    }
  }

  // 2) 固定清单 + 当天识别到的委托 → 生成流程
  const flows = [...config.flows, ...discovered];
  for (const flow of flows) {
    // 类型（战斗/采集）优先用日志里认出来的 —— 委托每天轮换，硬编码的类型对不上。
    // 认不出来时按**战斗型**处理：战斗型流程是「走到目标点 + 按 F 触发 + 自动战斗」，
    // 采集型要额外靠「在附近交互」找提示词，两者都能兜住；
    // 反过来（未知时套采集型的环形路径）会让战斗委托在原地绕圈打转（实测「疑似卡死」）。
    const known = types[flow.name];
    const collect = known ? known === 'collect' : flow.collect === true;
    const shaped = { ...flow, collect };
    const base = path.join(scriptDir, 'process', flow.country, 'Basic', flow.name);
    flow.points.forEach(([x, y], index) => {
      const dir = path.join(base, `${flow.location}-${index + 1}`);
      const steps = flowSteps(shaped);
      // 上游手录的流程不覆盖（它比插件生成的通用路线准得多）。
      const upstreamProcess = path.join(dir, 'process.json');
      const upstreamPath = path.join(dir, '_path.json');
      const keepUpstream =
        (fs.existsSync(upstreamProcess) && !isPluginGeneratedFlow(upstreamProcess)) ||
        (fs.existsSync(upstreamPath) && !isPluginGeneratedFlow(upstreamPath));
      if (keepUpstream) {
        skipped.push(dir);
        return;
      }
      if (writeIfChanged(upstreamProcess, `${JSON.stringify(steps, null, 2)}\n`)) {
        changed.push(upstreamProcess);
      }
      const pj = upstreamPath;
      const content = `${JSON.stringify(collect ? pathFile(shaped, x, y) : combatPathFile(shaped, x, y), null, 2)}\n`;
      if (writeIfChanged(pj, content)) changed.push(pj);
    });
  }

  // 3) 白名单：脚本只认「在 commission-catalog.json 里声明过」的委托
  const catalogFile = path.join(scriptDir, 'config', 'commission-catalog.json');
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    let touched = false;
    for (const flow of flows) {
      if (!Array.isArray(catalog.basic)) catalog.basic = [];
      if (!catalog.basic.includes(flow.name)) {
        catalog.basic.push(flow.name);
        touched = true;
      }
    }
    if (touched) {
      fs.writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
      changed.push(catalogFile);
    }
  } catch (error) {
    return { ok: false, error: `白名单写入失败：${String((error && error.message) || error)}` };
  }

  return {
    ok: true,
    changed,
    skippedUpstream: skipped.length,
    flows: flows.length,
    discovered: discovered.length,
    accounts: accounts.length,
    at: new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 「每日委托」配置组：历练点脚本优先 → 社区脚本兜底
//
// 用户要求（2026-11-09）：有历练点就先用历练点把每日委托秒了，
// 没有历练点再用脚本（跑图 + 战斗）做委托。
//
// 落地方式（两个社区脚本，官方仓库都有）：
//   ① 使用历练点完成每日委托 —— 领历练点奖励 + 顺路去冒险家协会领每日奖励；
//      没有历练点/识别不到时它自己 warn 后退出，不影响后面的脚本。
//   ② AutoCommissionNova —— 社区的委托脚本（跑图 + 战斗），作为兜底。
//
// 配置组文件放在 BetterGI 的 User\ScriptGroup\<组名>.json，
// 一条龙前置任务用它（--startGroups），跑在「领取每日奖励」之前，
// 委托做完，冒险之证（90 原石）才领得到。
// ---------------------------------------------------------------------------

/** 历练点脚本名（官方仓库 js 目录下的目录名）。 */
export const ENCOUNTER_POINT_SCRIPT = '使用历练点完成每日委托';

const BGI_SCRIPT_REPO_RAW = 'https://raw.githubusercontent.com/babalae/bettergi-scripts-list/main/repo/js';
const BGI_SCRIPT_REPO_LIST =
  'https://data.jsdelivr.com/v1/packages/gh/babalae/bettergi-scripts-list@main?structure=flat';

/** 脚本没装就从官方仓库补装（官方仓库的源码在 repo/js/<名字>/ 下）。 */
export async function ensureEncounterPointScript(bettergiRoot, scriptName = ENCOUNTER_POINT_SCRIPT) {
  const dir = path.join(bettergiRoot, 'User', 'JsScript', scriptName);
  if (fs.existsSync(path.join(dir, 'manifest.json'))) {
    return { ok: true, dir, installed: false, files: 0 };
  }
  let files = [];
  try {
    const resp = await fetch(BGI_SCRIPT_REPO_LIST, { headers: { 'User-Agent': 'dsh-game-daily' } });
    const json = await resp.json();
    const prefix = `/repo/js/${scriptName}/`;
    files = (json.files || [])
      .map((f) => f.name)
      .filter((n) => n.startsWith(prefix))
      .map((n) => n.slice(prefix.length));
  } catch (error) {
    return { ok: false, dir, error: `拿不到官方脚本清单：${String((error && error.message) || error)}` };
  }
  if (!files.length) {
    return { ok: false, dir, error: `官方仓库里没有 ${scriptName}` };
  }
  let saved = 0;
  for (const rel of files) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      const r = await fetch(`${BGI_SCRIPT_REPO_RAW}/${encodeURIComponent(scriptName)}/${rel}`);
      if (!r.ok) continue;
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      saved += 1;
    } catch {
      /* 单个文件失败就跳过，manifest 到位才算装好 */
    }
  }
  const ok = fs.existsSync(path.join(dir, 'manifest.json'));
  return { ok, dir, installed: true, files: saved };
}

/**
 * 确保「每日委托」配置组是「历练点脚本 → AutoCommissionNova」的顺序。
 *
 * 幂等：已经是目标形态就不改文件（避免每次运行都动 BetterGI 的配置）。
 * BetterGI 运行期间会回写这个文件，所以只能在跑之前写。
 */
export async function ensureCommissionGroup(
  bettergiRoot,
  { groupName = '每日委托', adventurePath = '至冬', commissionScript = 'AutoCommissionNova' } = {},
) {
  const dir = path.join(bettergiRoot, 'User', 'ScriptGroup');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${groupName}.json`);

  const ep = await ensureEncounterPointScript(bettergiRoot);
  const steps = [];
  if (ep.ok) {
    steps.push({
      name: `${ENCOUNTER_POINT_SCRIPT}.js`,
      folderName: ENCOUNTER_POINT_SCRIPT,
      jsScriptSettingsObject: {
        // 直接用历练点完成委托（不去好友尘歌壶拿双倍好感）
        notDoublePoints: true,
        // 不切队伍 → 脚本自己会检查「4 人队」，不满足就跳过领奖
        partyName: '',
        movePartyName: '',
        disableGoStatue: false,
        // 领奖要去冒险家协会：账号在至冬
        adventurePath,
        enableDebug: false,
      },
    });
  }
  steps.push({
    name: `${commissionScript}.js`,
    folderName: commissionScript,
    jsScriptSettingsObject: { runMode: '运行自动每日委托', showConfigEditor: false },
  });

  let group = {};
  try {
    group = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    group = { index: 1, name: groupName, config: {} };
  }
  group.name = groupName;
  group.projects = steps.map((p, index) => ({
    ...p,
    index,
    type: 'Javascript',
    status: 'Enabled',
    schedule: 'Daily',
    runNum: 1,
    allowJsNotification: true,
    allowJsHTTPHash: '',
  }));

  const content = `${JSON.stringify(group, null, 2)}\n`;
  let changed = false;
  try {
    changed = fs.readFileSync(file, 'utf8') !== content;
  } catch {
    changed = true;
  }
  if (changed) {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.bak-gd-ep-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    }
    fs.writeFileSync(file, content, 'utf8');
  }
  return {
    ok: true,
    file,
    changed,
    group: groupName,
    scripts: steps.map((p) => p.name),
    encounterPointScript: ep,
  };
}
