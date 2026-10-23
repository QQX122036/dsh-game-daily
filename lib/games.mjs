// 游戏注册表：新增游戏只改这里（对应 game-daily 技能 §5 扩展点）。
// 纯数据 + 小工具，Host 与客户端都只依赖这里的 id/标题/默认值。

export const GAMES = [
  {
    id: 'genshin',
    title: '原神',
    subtitle: 'Genshin Impact',
    engine: 'bettergi',
    process: ['YuanShen.exe', 'GenshinImpact.exe'],
    guardProcess: 'YuanShen',
    launcher: 'HYP.exe',
    defaultTime: '11:00',
    taskKey: 'genshin',
    skillModule: 'bettergi-control',
    skills: ['bettergi-control'],
    canRun: true,
    note: '经 BetterGI 触发「一条龙」，不改 BetterGI 配置。',
  },
  {
    id: 'hi',
    title: '崩坏3',
    subtitle: 'Honkai Impact 3rd',
    engine: 'skill',
    process: ['BH3.exe'],
    guardProcess: 'BH3',
    launcher: 'HYP.exe',
    defaultTime: '10:00',
    taskKey: 'hi',
    skillModule: 'game-daily-hi',
    skills: ['game-daily', 'game-daily-hi'],
    canRun: true,
    note: '按 game-daily-hi 的 14 步流程操作。',
  },
  {
    id: 'sr',
    title: '崩坏：星穹铁道',
    subtitle: 'Honkai: Star Rail',
    engine: 'skill',
    process: ['StarRail.exe'],
    guardProcess: 'StarRail',
    launcher: 'HYP.exe',
    defaultTime: '10:00',
    taskKey: 'sr',
    skillModule: 'game-daily-sr',
    skills: ['game-daily', 'game-daily-sr'],
    canRun: true,
    note: '按 game-daily-sr 的 14 步流程操作。',
  },
  {
    id: 'zzz',
    title: '绝区零',
    subtitle: 'Zenless Zone Zero',
    engine: 'disabled',
    process: ['ZenlessZoneZero.exe'],
    guardProcess: 'ZenlessZoneZero',
    launcher: 'HYP.exe',
    defaultTime: null,
    taskKey: 'zzz',
    skillModule: 'game-daily-zzz',
    skills: ['game-daily', 'game-daily-zzz'],
    canRun: false,
    note: '键鼠注入被 ACE 拦截，当前只维护文档，不做实操。',
  },
];

export const GAME_IDS = GAMES.map((g) => g.id);
export const RUNNABLE_GAME_IDS = GAMES.filter((g) => g.canRun).map((g) => g.id);

export function gameById(id) {
  return GAMES.find((g) => g.id === id) || null;
}

/** 计划任务名：默认 game-daily-<id>；dev 前缀由环境变量覆盖。 */
export function taskNameFor(prefix, gameId) {
  return `${prefix}${gameId}`;
}

export function isWeekdays(value) {
  return Array.isArray(value) && value.length > 0 && value.every((n) => Number.isInteger(n) && n >= 1 && n <= 7);
}

export const WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

export default GAMES;
