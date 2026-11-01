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
      { name: '为雪不净', country: '至冬', location: '古兽冰原', collect: true, points: [[7173, 7866], [7127, 7996]] },
      { name: '霜冰收藏家', country: '至冬', location: '古兽冰原', collect: true, points: [[7942, 8015]] },
    ],
  };
}

/**
 * 委托流程步骤。
 *
 * 采集委托（图标是「0/1」，目标是把元素微粒之类的东西捡起来）：
 *   地图追踪 → 在附近交互（绕着终点转圈找提示文字，找到就按 F）
 * 战斗委托：
 *   地图追踪 → 自动战斗
 *
 * 两个关键实测结论：
 * 1. 「在附近交互」找的是**动作词**而不是物品名 —— 原神在元素微粒旁边显示的是
 *    「F ⚙ 进入」，所以 text 要写「进入」，写「微粒」永远找不到（每轮要多等好几分钟）。
 * 2. 采集委托**不能**带「自动战斗」——采集点没有敌人，BetterGI 的自动战斗会一直等下去。
 *    「自动战斗」这一步本身是 swallow 的（出错不中断），放在最后当兜底是安全的。
 */
export function flowSteps(flow) {
  const steps = [{ type: '地图追踪', data: '_path.json' }];
  if (flow.collect === false) {
    steps.push({ type: '自动战斗', data: { timeout: 60 } });
    return steps;
  }
  // 类型未知的委托（每日轮换，脚本只给得出「Basic」）：两种都试。
  //   自动战斗：swallow 的，出错/超时都不会中断流程（战斗委托靠它打怪）
  //   在附近交互：采集委托靠它按 F（提示词是「进入」）
  // 战斗委托会在「在附近交互」这步找不到提示而报错，但怪已经打完了 —— 委托实际已完成。
  steps.push({ type: '自动战斗', data: { timeout: 60 } });
  steps.push({ type: '在附近交互', desc: '采集', data: { text: flow.interactText || '进入', turns: 2 } });
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
  const radius = Number(flow.radius) > 0 ? Number(flow.radius) : 20;
  const count = Number(flow.loopPoints) > 0 ? Number(flow.loopPoints) : 8;
  const positions = [
    // teleport = 传送点，BetterGI 会吸附到离它最近的传送锚点
    { action: '', action_params: '', id: 1, move_mode: 'walk', type: 'teleport', x, y },
  ];
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    positions.push({
      action: 'up_down_grab_leaf',
      action_params: '',
      id: i + 2,
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
export function ensureCommissionFlows(bettergiRoot, pluginRoot) {
  const config = readFlowConfig(pluginRoot);
  const scriptDir = path.join(bettergiRoot, 'User', 'JsScript', config.script);
  if (!fs.existsSync(scriptDir)) {
    return { ok: false, skipped: 'not-installed', error: `没有找到脚本目录：${scriptDir}` };
  }
  const changed = [];
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
      account.settings.checkEncounterPoints = false;
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
          collect: config.collectByDefault !== false,
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
    const base = path.join(scriptDir, 'process', flow.country, 'Basic', flow.name);
    flow.points.forEach(([x, y], index) => {
      const dir = path.join(base, `${flow.location}-${index + 1}`);
      const steps = flowSteps(flow);
      if (writeIfChanged(path.join(dir, 'process.json'), `${JSON.stringify(steps, null, 2)}\n`)) {
        changed.push(path.join(dir, 'process.json'));
      }
      const pj = path.join(dir, '_path.json');
      if (writeIfChanged(pj, `${JSON.stringify(pathFile(flow, x, y), null, 2)}\n`)) changed.push(pj);
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
    flows: flows.length,
    discovered: discovered.length,
    accounts: accounts.length,
    at: new Date(now).toISOString(),
  };
}
