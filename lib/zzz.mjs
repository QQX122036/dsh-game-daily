/**
 * lib/zzz.mjs — 绝区零「一条龙」(ZenlessZoneZero-OneDragon) 后端的最小控制层。
 *
 * 用途：
 *   - 依赖体检：后端是否可达、一条龙是否装在预期位置；
 *   - runner 起跑前确保后端在跑（必要时弹一次 UAC 启动）；
 *   - prompt 里给出的环境事实。
 *
 * 不在这里做任何游戏画面操作：画面识别/点击全部交给一条龙自己。
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');

export const DEFAULT_ZZZ_ROOT = 'D:\\software\\ZenlessZoneZero-OneDragon';

export function zzzRoot() {
  const fromEnv = process.env.DSH_GAME_DAILY_ZZZ_ROOT || process.env.ZZZ_OD_ROOT;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    DEFAULT_ZZZ_ROOT,
    'E:\\software\\ZenlessZoneZero-OneDragon',
    'D:\\ZenlessZoneZero-OneDragon',
    path.resolve(PLUGIN_ROOT, '..', 'ZenlessZoneZero-OneDragon'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, '.venv', 'Scripts', 'python.exe'))) return dir;
  }
  return DEFAULT_ZZZ_ROOT;
}

export function zzzBaseUrl() {
  return (process.env.DSH_GAME_DAILY_ZZZ_URL || 'http://127.0.0.1:23001').replace(/\/+$/, '');
}

export function zzzServerScript() {
  return path.join(PLUGIN_ROOT, 'automation', 'zzz-server.ps1');
}

function psPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function httpJson(urlPath, { method = 'GET', body, timeoutMs = 8000 } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${zzzBaseUrl()}${urlPath}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, data };
}

export async function zzzHealth(timeoutMs = 3000) {
  try {
    const r = await httpJson('/health', { timeoutMs });
    return { ok: r.ok, data: r.data };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** 同步版 health（给同步的依赖体检用；curl.exe 本机自带，超时 2 秒）。 */
export function zzzHealthSync({ timeoutMs = 2000 } = {}) {
  const url = `${zzzBaseUrl()}/health`;
  try {
    const out = execFileSync('curl.exe', ['-s', '-S', '-m', String(Math.max(1, Math.round(timeoutMs / 1000))), url], {
      timeout: timeoutMs + 1500,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 512 * 1024,
    }).trim();
    let data = null;
    try {
      data = out ? JSON.parse(out) : null;
    } catch {
      data = { raw: out.slice(0, 300) };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).slice(0, 300) };
  }
}

export async function zzzStatus() {
  try {
    const r = await httpJson('/game/status', { timeoutMs: 5000 });
    return r.data;
  } catch (error) {
    return { running: null, error: String((error && error.message) || error) };
  }
}

export async function zzzWindow() {
  try {
    const r = await httpJson('/game/window', { timeoutMs: 5000 });
    return r.data;
  } catch (error) {
    return { is_win_valid: false, error: String((error && error.message) || error) };
  }
}

/** 运行 zzz-server.ps1（start/stop/status）。start/stop 在非管理员下会让脚本自己弹一次 UAC。 */
export function runZzzServerScript(action, { timeoutSeconds = 45, stopFile = '' } = {}) {
  return new Promise((resolve) => {
    const script = zzzServerScript();
    if (!existsSync(script)) {
      resolve({ ok: false, error: `找不到后端管理脚本：${script}` });
      return;
    }
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Action',
      action,
      '-Root',
      zzzRoot(),
      '-Port',
      String(Number(new URL(zzzBaseUrl()).port) || 23001),
      '-WaitSeconds',
      String(Math.max(5, Math.min(120, timeoutSeconds))),
    ];
    if (stopFile) args.push('-StopFile', stopFile);
    execFile(psPath(), args, { timeout: (timeoutSeconds + 60) * 1000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const text = String(stdout || '').trim();
      let data = null;
      const i = text.lastIndexOf('{');
      if (i >= 0) {
        try {
          data = JSON.parse(text.slice(i));
        } catch {
          data = null;
        }
      }
      if (data) return resolve(data);
      resolve({ ok: false, error: String((error && error.message) || stderr || 'no result').slice(0, 500) });
    });
  });
}

/** 确保后端在跑：已健康直接返回；否则启动（可能弹一次 UAC）。
 *  stopFile 交给后端脚本：启动成功时它会顺带跑一个提权的 watch 助手，
 *  之后非提权的插件只要写这个文件就能关掉后端（不需要再弹 UAC）。 */
export async function ensureZzzServer({ timeoutSeconds = 45, stopFile = '' } = {}) {
  const before = await zzzHealth(2000);
  if (before.ok) return { ok: true, alreadyRunning: true, health: before.data, stopFile };
  const result = await runZzzServerScript('start', { timeoutSeconds, stopFile });
  const after = await zzzHealth(3000);
  return { ok: Boolean(after.ok), started: true, script: result, health: after.data, stopFile, error: after.ok ? undefined : result.error };
}

/** 关闭游戏：交给提权后的后端自己发关闭信号（普通权限杀不掉提权进程）。 */
export async function zzzCloseGame({ timeoutMs = 15000 } = {}) {
  try {
    const r = await httpJson('/game/close', { method: 'POST', body: {}, timeoutMs });
    return { ok: r.ok, data: r.data };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** 停止后端：优先写 stop 文件让提权的 watch 助手处理；没有再退回提权脚本（会弹 UAC）。 */
export async function stopZzzServer({ timeoutSeconds = 30, stateDir = '' } = {}) {
  const stopFile = stateDir ? path.join(stateDir, 'automation', 'zzz-server.stop') : '';
  if (stopFile) {
    try {
      fs.mkdirSync(path.dirname(stopFile), { recursive: true });
      fs.writeFileSync(stopFile, new Date().toISOString(), 'utf8');
    } catch { /* ignore */ }
    const limit = Date.now() + Math.max(5, timeoutSeconds) * 1000;
    while (Date.now() < limit) {
      const h = await zzzHealth(1500);
      if (!h.ok) return { ok: true, via: 'stop-file', stopFile };
      await new Promise((r) => setTimeout(r, 1000));
    }
    // 没有 watcher（例如后端是手动启的）时不要擅自弹 UAC，交给调用方决定。
    return { ok: false, via: 'stop-file', stopFile, reachable: true, error: '后端仍在运行：它可能不是由插件启动的（没有 watch 助手）。' };
  }
  const result = await runZzzServerScript('stop', { timeoutSeconds });
  const after = await zzzHealth(2000);
  return { ok: !after.ok, script: result, reachable: after.ok };
}

/** 依赖体检用：一条龙安装是否完整（根目录 + venv python + 后端源码）。 */
export function inspectZzzInstall() {
  const root = zzzRoot();
  const python = path.join(root, '.venv', 'Scripts', 'python.exe');
  const src = path.join(root, 'src', 'zzz_od');
  const hasPython = existsSync(python);
  const hasSrc = existsSync(src);
  return { root, python, hasPython, hasSrc, ok: hasPython && hasSrc };
}
