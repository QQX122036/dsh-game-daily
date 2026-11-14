#!/usr/bin/env node
/**
 * automation/zzz-weekly.mjs — 打开绝区零一条龙里的**周本**应用。
 *
 * 默认一条龙只跑每日（邮件/签到/随便观/咖啡/体力/活跃度/城募/尘歌壶）。
 * 周本内容在后端是现成的，只是默认关着：
 *   · notorious_hunt 恶名狩猎   —— 每周 3 次免费奖励（不耗电量）
 *   · shiyu_defense 式舆防卫战 —— 终局防守本，剧变节点双周刷新奖励
 *   · lost_void      零号空洞 —— 迷失之地，肉鸽爬层
 *   · ridu_weekly / withered_domain / world_patrol 也在这份清单里
 *
 * 用法：
 *   node automation/zzz-weekly.mjs            # 打开（幂等）
 *   node automation/zzz-weekly.mjs --disable  # 关掉
 *   node automation/zzz-weekly.mjs --dry-run  # 只看会改什么
 */
import fs from 'node:fs';
import path from 'node:path';

const ZZZ_ROOT = process.env.DSH_GAME_DAILY_ZZZ_ROOT || 'D:\\software\\ZenlessZoneZero-OneDragon';
const GROUP = path.join(ZZZ_ROOT, 'config', '01', 'one_dragon', '_group.yml');
const DISABLE = process.argv.includes('--disable');
const DRY = process.argv.includes('--dry-run');
const TOGGLES = ['notorious_hunt', 'shiyu_defense', 'lost_void'];

function main() {
  if (!fs.existsSync(GROUP)) {
    process.stdout.write(`[zzz-weekly] 找不到 ${GROUP}\n`);
    process.exit(2);
  }
  const text = fs.readFileSync(GROUP, 'utf8');
  const out = [];
  const lines = text.split(/\r?\n/);
  let changed = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    out.push(line);
    const m = /^- app_id:\s*(\S+)\s*$/.exec(line);
    if (!m || !TOGGLES.includes(m[1])) continue;
    const next = lines[i + 1] || '';
    const want = DISABLE ? 'false' : 'true';
    if (/^\s*enabled:\s*(true|false)\s*$/.test(next)) {
      if (!new RegExp(`^\\s*enabled:\\s*${want}\\s*$`).test(next)) {
        out[out.length - 1] = line;
        out.push(next.replace(/enabled:\s*(true|false)/, `enabled: ${want}`));
        changed.push(`${m[1]}=${want}`);
      }
    }
  }
  const content = out.join('\n');
  if (content === text) {
    process.stdout.write(`[zzz-weekly] 已经是目标形态（${DISABLE ? '关闭' : '开启'}），不改文件\n`);
    return;
  }
  if (!DRY) {
    fs.copyFileSync(GROUP, `${GROUP}.bak-weekly-${Date.now()}`);
    fs.writeFileSync(GROUP, content, 'utf8');
  }
  process.stdout.write(`[zzz-weekly] ${DISABLE ? '关闭' : '开启'}: ${changed.join(', ') || '无变化'}${DRY ? '（dry-run，未写入）' : ''}\n`);
}

main();
