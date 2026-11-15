// 把星铁周本队伍换成「列表首页就能被模板匹配到」的角色。
// 背景：M7A 找角色只在当前列表页做图像匹配（滚动方向也只会往下翻），
// 账号角色多、排序按等级，自有角色大多不在首页 → 报「XX未找到」。
// Tingyun / Qingque / Guinaifen 在首页可见（模板匹配 0.90+），先用它们。
import fs from 'node:fs';

const CONFIG = 'D:\\March7thAssistant_full\\March7thAssistant_full\\config.yaml';
const TEAM = [
  ['YaoGuang', -1],
  ['Bailu', 1],
  ['Huohuo', 1],
  ['Gallagher', -1],
];
const SOLO = [['YaoGuang', -1]];

function block(list) {
  const out = [];
  for (const [name, count] of list) {
    out.push(`- - ${name}`);
    out.push(`  - ${count}`);
  }
  return out.join('\n');
}

const keys1 = ['forgottenhall_team1', 'forgottenhall_team2', 'purefiction_team1', 'purefiction_team2', 'apocalyptic_team1', 'apocalyptic_team2'];
const keys3 = ['forgottenhall_team3', 'purefiction_team3', 'apocalyptic_team3'];
const lines = fs.readFileSync(CONFIG, 'utf8').split(/\r?\n/);
const out = [];
let i = 0;
let touched = 0;
while (i < lines.length) {
  const m = /^([a-z0-9_]+):/.exec(lines[i]);
  if (m && keys1.includes(m[1])) {
    out.push(`${m[1]}:`);
    out.push(block(TEAM));
    i += 1;
    while (i < lines.length && (/^\s*-\s/.test(lines[i]) || /^\s+-?\s*-?\d+\s*$/.test(lines[i]))) i += 1;
    touched += 1;
    continue;
  }
  out.push(lines[i]);
  i += 1;
}
for (const key of keys3) {
  const idx = out.findIndex((l) => l.startsWith(`${key}:`));
  if (idx < 0) continue;
  let end = idx + 1;
  while (end < out.length && (/^\s*-\s/.test(out[end]) || /^\s+-?\s*-?\d+\s*$/.test(out[end]))) end += 1;
  out.splice(idx + 1, end - idx - 1, block(SOLO));
  touched += 1;
}
fs.copyFileSync(CONFIG, `${CONFIG}.bak-team3-${Date.now()}`);
fs.writeFileSync(CONFIG, out.join('\n'), 'utf8');
console.log(`[m7a-teams3] 改了 ${touched} 个队伍配置 -> ${TEAM.map((t) => t[0]).join('/')}`);
