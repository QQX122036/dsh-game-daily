/**
 * automation/zzz-fallback.mjs — 手动查看/改写绝区零「清体力」计划（charge_plan.yml）。
 *
 * 现状：把一条龙的体力计划改成「区域巡防」（驱动盘本），按清单顺序轮着刷指定套装，
 * 每天把电量花在目标角色要用的驱动盘上（默认蕾米埃尔 + 菲欧妮，见 ZZZ_DISC_CHARACTER_TARGETS）。
 *
 * 用法：
 *   node automation/zzz-fallback.mjs                 # 立即确保（会改 charge_plan.yml）
 *   node automation/zzz-fallback.mjs --dry-run       # 只看会改什么
 *   node automation/zzz-fallback.mjs --list          # 列出可选的驱动盘副本 + 角色需求
 *   node automation/zzz-fallback.mjs --missions 迅脊与裂爪,锐牙与钝斧
 *   node automation/zzz-fallback.mjs --mission 怪兽与怪客 --agent 12 --disc 4
 *   node automation/zzz-fallback.mjs --config        # 打印当前兜底配置与文件位置
 */
import {
  ZZZ_DISC_CHARACTER_TARGETS,
  ZZZ_DISC_MISSION_TYPES,
  ensureZzzChargePlanFallback,
  findZzzChargePlanPath,
  zzzFallbackConfig,
  zzzFallbackPath,
  zzzRoot,
} from '../lib/zzz.mjs';

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes('--list')) {
  console.log('# 区域巡防副本类型 → 掉落的驱动盘套装（每个本 60 电量）');
  for (const item of ZZZ_DISC_MISSION_TYPES) {
    const marks = ZZZ_DISC_CHARACTER_TARGETS
      .filter((t) => t.missionTypeNames.includes(item.missionTypeName))
      .map((t) => t.character);
    console.log(`${item.missionTypeName}\t${item.discs.join(' / ')}${marks.length ? `\t← ${marks.join('/')}` : ''}`);
  }
  console.log('');
  console.log('# 目标角色的驱动盘需求');
  for (const t of ZZZ_DISC_CHARACTER_TARGETS) {
    const sets = Object.entries(t.sets).map(([k, v]) => `${k}=${[].concat(v).join('/')}`).join(' ');
    console.log(`${t.character}(${t.alias}) ${t.attribute}属性${t.role}\t${sets}`);
    console.log(`    刷这些副本：${t.missionTypeNames.join('、')}\t${t.note}`);
  }
  process.exit(0);
}

if (process.argv.includes('--config')) {
  console.log(JSON.stringify({
    root: zzzRoot(),
    chargePlan: findZzzChargePlanPath(),
    fallbackFile: zzzFallbackPath(),
    config: zzzFallbackConfig(),
    characterTargets: ZZZ_DISC_CHARACTER_TARGETS,
  }, null, 2));
  process.exit(0);
}

const overrides = {};
const mission = argOf('--mission');
if (mission) overrides.missionTypeName = mission;
const missions = argOf('--missions');
if (missions) {
  const list = missions.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
  if (list.length) overrides.missionTypeNames = list;
}
const agent = argOf('--agent');
if (agent) overrides.agentPlanTimes = Number(agent);
const disc = argOf('--disc');
if (disc) overrides.discPlanTimes = Number(disc);

const dryRun = process.argv.includes('--dry-run');
const result = ensureZzzChargePlanFallback({
  dryRun,
  config: { ...zzzFallbackConfig(), ...overrides },
});
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
