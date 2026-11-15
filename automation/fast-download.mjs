#!/usr/bin/env node
/**
 * automation/fast-download.mjs — 多路并发分段下载（绕过单连接限速），带校验与断点续传。
 *
 * 为什么需要：GitHub Release 资源在这台机器上单连接只有 ~0.02 MB/s
 * （M7A 更新包 157 MB 要 2 小时）。分段并发能把带宽用满。
 *
 * 用法：
 *   node automation/fast-download.mjs <url> <输出文件> [并发数] [分块MB] [期望sha256]
 *
 * 可靠性要点：
 *   - 每段必须返回 206 且 Content-Range 起点匹配，否则整段重试（不写盘）。
 *   - 每段写完后在 .parts 状态文件里记完成标记，中断后重跑可续传。
 *   - 给出期望 sha256 时，校验不过就整份重下（最多 3 轮），避免再次出现
 *     「大小正确、魔数正确、内容却是坏的」这种假成功。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const url = args[0];
const out = args[1];
const workers = Number(args[2] || 32);
const chunkMB = Number(args[3] || 4);
const expectSha = (args[4] || '').trim().toLowerCase();
if (!url || !out) {
  process.stdout.write('用法: node fast-download.mjs <url> <输出文件> [并发数] [分块MB] [期望sha256]\n');
  process.exit(2);
}

const HEAD = { 'User-Agent': 'dsh-game-daily/1.0' };
const abs = path.resolve(out);
const statePath = `${abs}.parts`;

function log(msg) {
  process.stdout.write(`[fast ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return Array.isArray(value.done) ? new Set(value.done) : new Set();
  } catch {
    return new Set();
  }
}

function writeState(done) {
  fs.writeFileSync(statePath, JSON.stringify({ done: [...done] }));
}

async function probe() {
  // GitHub 连接经常超时（实测前两次 Connect Timeout、第三次才通），所以要重试。
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const resp = await fetch(url, { method: 'HEAD', headers: HEAD, redirect: 'follow' });
      if (!resp.ok) throw new Error(`HEAD ${resp.status}`);
      const len = Number(resp.headers.get('content-length') || 0);
      if (!len) throw new Error('拿不到文件长度');
      return { len, finalUrl: resp.url };
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    }
  }
  throw lastError;
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function downloadOnce(finalUrl, len, chunk, t0) {
  const total = Math.ceil(len / chunk);
  log(`${(len / 1048576).toFixed(1)} MB，共 ${total} 段，每段 ${(chunk / 1048576).toFixed(1)} MB，${workers} 路并发`);

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const done = readState();
  const fd = fs.openSync(abs, fs.existsSync(abs) ? 'r+' : 'w+');
  try {
    if (fs.fstatSync(fd).size !== len) {
      fs.ftruncateSync(fd, len);
      done.clear();
    }
  } catch {
    fs.ftruncateSync(fd, len);
    done.clear();
  }

  let bytes = 0;
  let lastReport = Date.now();
  const report = () => {
    const now = Date.now();
    if (now - lastReport < 5000) return;
    lastReport = now;
    const mb = bytes / 1048576;
    const speed = mb / ((now - t0) / 1000);
    log(`${mb.toFixed(1)}/${(len / 1048576).toFixed(1)} MB  ${speed.toFixed(3)} MB/s  完成 ${done.size}/${total} 段`);
  };

  const fetchChunk = async (index) => {
    const start = index * chunk;
    const end = Math.min(len - 1, start + chunk - 1);
    const want = end - start + 1;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const resp = await fetch(finalUrl, {
          headers: { ...HEAD, Range: `bytes=${start}-${end}` },
          redirect: 'follow',
        });
        if (resp.status !== 206) throw new Error(`HTTP ${resp.status}（需要 206）`);
        const range = resp.headers.get('content-range') || '';
        if (!range.startsWith(`bytes ${start}-`)) throw new Error(`Content-Range 不匹配：${range}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length !== want) throw new Error(`长度不符 ${buf.length}/${want}`);
        fs.writeSync(fd, buf, 0, buf.length, start);
        bytes += buf.length;
        done.add(index);
        writeState(done);
        report();
        return;
      } catch (error) {
        if (attempt === 9) throw new Error(`第 ${index} 段失败：${String(error && error.message)}`);
        await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
      }
    }
  };

  const queue = [];
  for (let i = 0; i < total; i += 1) if (!done.has(i)) queue.push(i);

  // 每个 worker 循环取段（不是一人一段），否则段数多于并发数时尾部几段永远不会被下载。
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const index = queue[cursor];
      cursor += 1;
      await fetchChunk(index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, () => worker()));
  if (done.size !== total) throw new Error(`只下了 ${done.size}/${total} 段`);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return total;
}

async function main() {
  const t0 = Date.now();
  const { len, finalUrl } = await probe();
  const chunk = Math.ceil(chunkMB * 1048576);
  const rounds = expectSha === '' ? 1 : 3;

  for (let round = 1; round <= rounds; round += 1) {
    if (round > 1) {
      log(`第 ${round} 轮：重新下载整份文件`);
      try { fs.unlinkSync(statePath); } catch { /* 没有状态文件就无所谓 */ }
    }
    await downloadOnce(finalUrl, len, chunk, t0);

    // 完整性校验：7z 魔数 + 抽样非零字节
    const check = fs.openSync(abs, 'r');
    const head = Buffer.alloc(6);
    fs.readSync(check, head, 0, 6, 0);
    const sample = Buffer.alloc(65536);
    let nonZero = 0;
    for (const off of [0, Math.floor(len / 3), Math.floor((len * 2) / 3), len - 65536]) {
      fs.readSync(check, sample, 0, 65536, off);
      for (const b of sample) if (b !== 0) nonZero += 1;
    }
    fs.closeSync(check);
    const magic = head.toString('hex');
    const magicOk = magic === '377abcaf271c';
    log(`校验：魔数 ${magic}${magicOk ? ' ✓' : ' ✗'}，抽样非零字节 ${nonZero}${nonZero > 1000 ? ' ✓' : ' ✗'}`);
    if (!magicOk || nonZero <= 1000) {
      process.stderr.write('[fast] 下载内容校验失败\n');
      if (round === rounds) process.exit(1);
      continue;
    }

    if (expectSha !== '') {
      const sha = await sha256Of(abs);
      if (sha !== expectSha) {
        log(`sha256 不符：本地 ${sha}，期望 ${expectSha}`);
        if (round === rounds) {
          process.stderr.write('[fast] sha256 校验失败，已重试到上限\n');
          process.exit(1);
        }
        continue;
      }
      log(`sha256 ✓ ${sha}`);
    }

    try { fs.unlinkSync(statePath); } catch { /* 没有状态文件就无所谓 */ }
    const sec = (Date.now() - t0) / 1000;
    log(`完成：${(len / 1048576).toFixed(1)} MB / ${sec.toFixed(0)}s（${(len / 1048576 / sec).toFixed(3)} MB/s）`);
    return;
  }
}

main().catch((error) => {
  process.stderr.write(`[fast] 失败：${String((error && error.message) || error)}\n`);
  process.exit(1);
});
