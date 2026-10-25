// 技能安装：从独立仓库拉 zip、校验、原子替换到技能根目录。
//
// 技能本体都在用户自己的 GitHub 仓库里（见 SKILL_REPOS），插件不捆绑它们：
// 依赖体检发现缺失时，点「修复」就走这里下载安装，不用开会话、不用手敲命令。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PS = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);

/** 可自动安装的技能：zip 走 codeload，避免往用户机器里塞 git。 */
export const SKILL_REPOS = {
  'bettergi-control': {
    repo: 'gychen-NJU/bettergi-control',
    branch: 'main',
    zip: 'https://codeload.github.com/gychen-NJU/bettergi-control/zip/refs/heads/main',
    required: ['SKILL.md', 'scripts'],
    minScripts: 10,
  },
};

export function skillSpec(name) {
  return SKILL_REPOS[name] || null;
}

export function skillInstallPath(root, name) {
  return path.join(root || '', name);
}

export function inspectSkill(root, name) {
  const dir = skillInstallPath(root, name);
  const skillMd = path.join(dir, 'SKILL.md');
  const installed = fs.existsSync(skillMd);
  let scripts = 0;
  try {
    scripts = fs.readdirSync(path.join(dir, 'scripts')).filter((file) => /\.ps1$/i.test(file)).length;
  } catch {
    scripts = 0;
  }
  return { dir, installed, skillMd, scripts };
}

function countFiles(dir) {
  let total = 0;
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(current, entry.name));
      else total += 1;
    }
  };
  walk(dir);
  return total;
}

function moveDir(from, to) {
  try {
    fs.renameSync(from, to);
  } catch {
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 下载并安装一个技能。
 * 顺序：下载 zip → Expand-Archive 到临时目录 → 校验 SKILL.md/脚本数 → 备份旧目录 → 原子换上。
 * 失败不会破坏旧版本（旧目录只在最后一步才改名）。
 */
export async function installSkill(name, { root, timeoutMs = 90000 } = {}) {
  const spec = skillSpec(name);
  if (!spec) return { ok: false, error: `未知技能：${name}` };
  if (!root) return { ok: false, error: '缺少技能根目录（skillsRoot）' };

  const target = skillInstallPath(root, name);
  const stamp = Date.now();
  const zipFile = path.join(os.tmpdir(), `gd-${name}-${stamp}.zip`);
  const workDir = path.join(os.tmpdir(), `gd-${name}-${stamp}`);

  try {
    fs.mkdirSync(workDir, { recursive: true });
    let response;
    try {
      response = await fetch(spec.zip, {
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.max(10000, Number(timeoutMs) || 90000)),
        headers: { 'user-agent': 'dsh-game-daily' },
      });
    } catch (error) {
      return { ok: false, error: `下载失败：${String((error && error.message) || error)}` };
    }
    if (!response.ok) return { ok: false, error: `下载失败：HTTP ${response.status} ${spec.zip}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 5000) return { ok: false, error: `下载内容过小：${buffer.length} 字节` };
    fs.writeFileSync(zipFile, buffer);

    const script = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${psQuote(zipFile)} -DestinationPath ${psQuote(workDir)} -Force; Write-Output 'ok'`;
    try {
      execFileSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        encoding: 'utf8',
        timeout: 120000,
        windowsHide: true,
      });
    } catch (error) {
      return { ok: false, error: `解压失败：${String((error && error.message) || error)}` };
    }

    const dirs = fs
      .readdirSync(workDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    const inner = dirs.find((entry) => fs.existsSync(path.join(workDir, entry.name, 'SKILL.md')));
    if (!inner) return { ok: false, error: '压缩包里没有 SKILL.md' };
    const sourceDir = path.join(workDir, inner.name);

    for (const required of spec.required || []) {
      if (!fs.existsSync(path.join(sourceDir, required))) {
        return { ok: false, error: `安装包缺少 ${required}` };
      }
    }
    const scripts = (() => {
      try {
        return fs.readdirSync(path.join(sourceDir, 'scripts')).filter((file) => /\.ps1$/i.test(file)).length;
      } catch {
        return 0;
      }
    })();
    if (scripts < spec.minScripts) {
      return { ok: false, error: `脚本数量不足：${scripts} < ${spec.minScripts}` };
    }

    fs.mkdirSync(root, { recursive: true });
    let backup = '';
    if (fs.existsSync(target)) {
      backup = `${target}.bak-${stamp}`;
      fs.renameSync(target, backup);
    }
    moveDir(sourceDir, target);
    if (!fs.existsSync(path.join(target, 'SKILL.md'))) {
      return { ok: false, error: '安装后回读 SKILL.md 失败', backup };
    }
    return {
      ok: true,
      path: target,
      backup,
      scripts,
      files: countFiles(target),
      bytes: buffer.length,
      repo: spec.repo,
    };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    try {
      fs.rmSync(zipFile, { force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
