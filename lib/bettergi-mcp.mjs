// bettergi-mcp：路径解析与按需下载。
//
// 这个 MCP 服务器是独立的开源项目（https://github.com/gychen-NJU/bettergi-mcp），
// 插件不捆绑它：优先用环境变量指定的现成副本；没有就把单文件服务器下载到
// <stateDir>/vendor/bettergi-mcp/。这样插件包保持零依赖，MCP 也能独立升级。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BETTERGI_MCP_REPO = 'gychen-NJU/bettergi-mcp';
export const BETTERGI_MCP_RAW = `https://raw.githubusercontent.com/${BETTERGI_MCP_REPO}/main/bettergi-mcp.mjs`;

/** 插件根目录（兼容 link 安装：真实文件所在目录）。 */
function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** 下载副本的固定位置。 */
export function vendorPath(stateDir) {
  return path.join(stateDir, 'vendor', 'bettergi-mcp', 'bettergi-mcp.mjs');
}

/** 没有环境变量 / 下载副本时，看看常见的同机位置。 */
function fallbackCandidates() {
  return [
    // 与本插件同级的 dsh-betterGI 工作区（本机常见布局）
    path.resolve(pluginRoot(), '..', 'dsh-betterGI', 'tools', 'bettergi-mcp', 'bettergi-mcp.mjs'),
    path.resolve(pluginRoot(), 'vendor', 'bettergi-mcp', 'bettergi-mcp.mjs'),
  ];
}

/**
 * 解析 bettergi-mcp 服务器脚本路径。
 * 顺序：DSH_GAME_DAILY_BETTERGI_MCP → <stateDir>/vendor → 同级工作区。
 * 找不到返回 null（不报错，由体检/运行前的提示负责）。
 */
export function resolveBettergiMcp({ stateDir } = {}) {
  const fromEnv = process.env.DSH_GAME_DAILY_BETTERGI_MCP;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [];
  if (stateDir) candidates.push(vendorPath(stateDir));
  candidates.push(...fallbackCandidates());
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return file;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 从 GitHub 下载 bettergi-mcp.mjs 到 <stateDir>/vendor/bettergi-mcp/。
 * 只取单文件（服务器零依赖、单文件分发），原子写，失败不动旧副本。
 */
export async function fetchBettergiMcp({ stateDir, url = BETTERGI_MCP_RAW, timeoutMs = 30000 } = {}) {
  if (!stateDir) return { ok: false, error: '缺少 stateDir' };
  const target = vendorPath(stateDir);
  let text;
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || 30000)),
    });
    if (!response.ok) return { ok: false, error: `下载失败：HTTP ${response.status} ${url}` };
    text = await response.text();
  } catch (error) {
    return { ok: false, error: `下载失败：${String((error && error.message) || error)}` };
  }
  if (!text || text.length < 10000 || !/MCP|mcp/.test(text)) {
    return { ok: false, error: '下载内容不像 bettergi-mcp.mjs（长度或内容校验失败）' };
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);
  } catch (error) {
    return { ok: false, error: `写入失败：${String((error && error.message) || error)}` };
  }
  return { ok: true, path: target, bytes: Buffer.byteLength(text), url, repo: BETTERGI_MCP_REPO };
}
