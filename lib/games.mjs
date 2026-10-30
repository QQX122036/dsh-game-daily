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
    defaultTimeoutMin: 150,
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
    defaultTimeoutMin: 45,
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
    // March7thAssistant（三月七小助手）的 CLI；比「截图→认屏→坐标点击」稳且快。
    engine: 'm7a',
    // main = M7A 的「完整运行」：版本检查 → 启动游戏 → 每日实训（含清体力）→ 领奖励。
    // 若只想跑其中一段，可用 DSH_GAME_DAILY_M7A_TASK 覆盖（daily / power / routine …）。
    m7aTasks: ['power', 'daily'],
    process: ['StarRail.exe'],
    guardProcess: 'StarRail',
    launcher: 'HYP.exe',
    defaultTime: '10:00',
    defaultTimeoutMin: 45,
    taskKey: 'sr',
    skillModule: 'game-daily-sr',
    skills: ['game-daily', 'game-daily-sr'],
    canRun: true,
    note: '走 March7thAssistant 的完整运行（main）：每日实训 + 清体力 + 领奖励（需 M7A 已安装并以管理员运行）。',
  },
  {
    id: 'zzz',
    title: '绝区零',
    subtitle: 'Zenless Zone Zero',
    // 直连一条龙后端（HTTP），不再让 headless agent 用 zzz-od MCP 转述。
    engine: 'zzz-direct',
    process: ['ZenlessZoneZero.exe'],
    guardProcess: 'ZenlessZoneZero',
    launcher: 'HYP.exe',
    defaultTime: '12:00',
    defaultTimeoutMin: 60,
    taskKey: 'zzz',
    skillModule: 'zzz-od-control',
    skills: ['zzz-od-control'],
    canRun: true,
    note: '走 ZenlessZoneZero-OneDragon（一条龙）后端：打开并登录游戏 → 执行日常应用（邮件/签到/咖啡店/录像店/城募/活跃度/周纪）。',
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
