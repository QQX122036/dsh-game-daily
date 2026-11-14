#!/usr/bin/env node
/**
 * automation/m7a-teams.mjs — 按账号**实际拥有**的角色重配三月七小助手的周本队伍。
 *
 * 为什么需要：M7A 自带的默认队伍是给「毕业账号」写的（景元/符玄/佩拉/青雀…），
 * 账号里没有的角色会让「配置队伍失败 → 挑战失败」——实测 2026-11-14：
 * 混沌回忆打到第 12 层、虚构叙事打到第 4 层，都因为 "JingYuan未找到" 而失败。
 *
 * 本脚本做的事：
 *   1) 读角色导出（characters.partial.json / characters.json，由
 *      `m7a.exe character_export` 生成）→ 得到账号真实拥有的角色；
 *   2) 挑出「M7A 认识 + 账号拥有」的四个角色写成周本队伍；
 *   3) 幂等：已经是目标形态就不改文件。
 *
 * 用法：
 *   node automation/m7a-teams.mjs                 # 自动按导出结果重配
 *   node automation/m7a-teams.mjs --dry-run       # 只看会改什么
 *   node automation/m7a-teams.mjs --export        # 先跑一次 character_export 再重配
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const M7A_ROOT = process.env.DSH_GAME_DAILY_M7A_ROOT || 'D:\\March7thAssistant_full\\March7thAssistant_full';
const CONFIG = path.join(M7A_ROOT, 'config.yaml');
const DRY = process.argv.includes('--dry-run');
const EXPORT = process.argv.includes('--export');

// 角色名（导出里的中文名）→ M7A 配置里的英文名。
// 只放「M7A 默认配置里就在用」的经典角色，识别最稳。
const NAME_MAP = {
  停云: 'Tingyun',
  藿藿: 'Huohuo',
  白露: 'Bailu',
  加拉赫: 'Gallagher',
  青雀: 'Qingque',
  花火: 'Sparkle',
  星期日: 'Sunday',
  布洛妮娅: 'Bronya',
  银狼: 'SilverWolf',
  '银狼LV.999': 'SilverWolfLV999',
  希儿: 'Seele',
  符玄: 'FuXuan',
  佩拉: 'Pela',
  艾丝: 'Asta',
  景元: 'JingYuan',
  爻光: 'YaoGuang',
  真珠: 'Pearl',
  远坂凛: 'RinTohsaka',
  吉尔伽美什: 'Gilgamesh',
  寒鸦: 'Hanya',
  丹恒: 'DanHeng',
  '丹恒·腾荒': 'DanHengPermansorTerrae',
};

// 队伍模板：4 人（同谐/丰饶/输出）。秘技次数，-1 = 终结技+普攻位。
const TEAM = [
  ['Tingyun', 2],
  ['Bailu', 1],
  ['Huohuo', 1],
  ['YaoGuang', -1],
];
const SOLO = [['DanHengPermansorTerrae', -1]];

function findRoster() {
  for (const name of ['characters.json', 'characters.partial.json']) {
    const file = path.join(M7A_ROOT, name);
    if (!fs.existsSync(file)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(json.characters) ? json.characters : [];
      const owned = new Set();
      for (const c of list) {
        const key = String(c.name || '').replace(/LV\.\d+$/i, '');
        const en = NAME_MAP[key] || NAME_MAP[c.name];
        if (en) owned.add(en);
      }
      if (owned.size) return { file, owned };
    } catch {
      /* ignore */
    }
  }
  return null;
}

function yamlBlock(list) {
  const out = [];
  for (const [name, count] of list) {
    out.push(`    - - ${name}`);
    out.push(`      - ${count}`);
  }
  return out.join('\n');
}

function main() {
  if (EXPORT) {
    const exe = path.join(M7A_ROOT, 'm7a.exe');
    log('跑 character_export 导出角色…');
    execFileSync(exe, ['character_export', '--non-interactive'], { cwd: M7A_ROOT, stdio: 'ignore', timeout: 600000 });
  }

  const roster = findRoster();
  if (!roster) {
    log('没找到角色导出文件（characters.json / characters.partial.json）。先跑：m7a.exe character_export');
    process.exit(2);
  }
  log(`账号角色（可识别的 ${roster.owned.size} 个）：${[...roster.owned].join(', ')}`);

  const team = TEAM.filter(([name]) => roster.owned.has(name));
  const fallback = [
    ['Tingyun', 2],
    ['Bailu', 1],
    ['Huohuo', 1],
    ['Gallagher', -1],
  ].filter(([name]) => roster.owned.has(name));
  const chosen = team.length >= 3 ? team : fallback;
  if (!chosen.length) {
    log('账号里没有 M7A 认识的可用角色，放弃');
    process.exit(3);
  }
  const solo = SOLO.filter(([name]) => roster.owned.has(name));
  log(`周本队伍：${chosen.map(([n]) => n).join(' / ')}`);

  if (!fs.existsSync(CONFIG)) {
    log(`找不到 ${CONFIG}`);
    process.exit(2);
  }
  const lines = fs.readFileSync(CONFIG, 'utf8').split(/\r?\n/);
  const keys = [
    'forgottenhall_team1', 'forgottenhall_team2',
    'purefiction_team1', 'purefiction_team2',
    'apocalyptic_team1', 'apocalyptic_team2',
  ];
  const out = [];
  let i = 0;
  let touched = 0;
  while (i < lines.length) {
    const m = /^([a-z0-9_]+):/.exec(lines[i]);
    if (m && keys.includes(m[1])) {
      out.push(`${m[1]}: # dsh-game-daily 按账号实际角色重配`);
      out.push(yamlBlock(chosen));
      i += 1;
      while (i < lines.length && (/^\s*-\s/.test(lines[i]) || /^\s+-?\s*-?\d+\s*$/.test(lines[i]))) i += 1;
      touched += 1;
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  for (const key of ['forgottenhall_team3', 'purefiction_team3', 'apocalyptic_team3']) {
    const idx = out.findIndex((l) => l.startsWith(`${key}:`));
    if (idx < 0 || !solo.length) continue;
    let end = idx + 1;
    while (end < out.length && (/^\s*-\s/.test(out[end]) || /^\s+-?\s*-?\d+\s*$/.test(out[end]))) end += 1;
    out.splice(idx + 1, end - idx - 1, yamlBlock(solo));
    touched += 1;
  }

  const content = out.join('\n');
  if (content === fs.readFileSync(CONFIG, 'utf8')) {
    log('配置已经是目标形态，不改文件');
    return;
  }
  if (!DRY) {
    fs.copyFileSync(CONFIG, `${CONFIG}.bak-teams-${Date.now()}`);
    fs.writeFileSync(CONFIG, content, 'utf8');
  }
  log(`重配 ${touched} 个队伍配置${DRY ? '（dry-run，未写入）' : ''}`);
}

function log(text) {
  process.stdout.write(`[m7a-teams] ${text}\n`);
}

main();
