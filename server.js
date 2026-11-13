/**
 * 通话录音上传 / 存储服务（零依赖，Node.js 18+）
 *
 * 接口：
 *   POST /api/upload   multipart/form-data，字段 file（音频）+ phoneNumber / duration / source / recordedAt
 *                      可选请求头 X-Token（服务端设置了 UPLOAD_TOKEN 时必填）
 *   GET  /api/list     已上传文件列表（JSON）
 *   GET  /api/health   健康检查
 *   GET  /files/<name> 下载 / 播放某个录音
 *   GET  /             简单的网页列表
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8000);
const HOST = '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const TOKEN = String(process.env.UPLOAD_TOKEN || '').trim();
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 64);
const MAX_BYTES = Math.max(1, MAX_MB) * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = {
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.amr': 'audio/amr',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.3gp': 'audio/3gpp',
  '.json': 'application/json; charset=utf-8',
};

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

/** 把 multipart 请求体拆成若干段（字段 / 文件） */
function parseMultipart(buf, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const crlfDelimiter = Buffer.from(`\r\n--${boundary}`);
  const parts = [];
  let pos = buf.indexOf(delimiter);
  if (pos === -1) return parts;

  while (pos !== -1) {
    let start = pos + delimiter.length;
    if (buf.subarray(start, start + 2).toString() === '--') break;
    if (buf.subarray(start, start + 2).toString() === '\r\n') start += 2;

    const headerEnd = buf.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;

    const headerText = buf.subarray(start, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const next = buf.indexOf(crlfDelimiter, dataStart);
    if (next === -1) break;

    parts.push({
      name: (/name="([^"]*)"/i.exec(headerText) || [])[1] || '',
      filename: (/filename="([^"]*)"/i.exec(headerText) || [])[1],
      data: buf.subarray(dataStart, next),
    });
    pos = next + 2;
  }
  return parts;
}

function sanitizeName(name) {
  const base = path.basename(name || '').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  return base.slice(-80) || 'recording.m4a';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function handleUpload(req, res) {
  const ct = String(req.headers['content-type'] || '');
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!ct.toLowerCase().startsWith('multipart/form-data') || !match) {
    return json(res, 400, { ok: false, error: '需要 multipart/form-data' });
  }
  if (TOKEN && String(req.headers['x-token'] || '') !== TOKEN) {
    return json(res, 401, { ok: false, error: '访问令牌不正确' });
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BYTES) {
    return json(res, 413, { ok: false, error: `文件超过 ${MAX_MB}MB 限制` });
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        return json(res, 413, { ok: false, error: `文件超过 ${MAX_MB}MB 限制` });
      }
      chunks.push(chunk);
    }
  } catch {
    return json(res, 400, { ok: false, error: '读取请求体失败' });
  }

  const boundary = (match[1] || match[2]).trim();
  const parts = parseMultipart(Buffer.concat(chunks), boundary);
  const filePart = parts.find((p) => p.filename !== undefined);
  if (!filePart || !filePart.data.length) {
    return json(res, 400, { ok: false, error: '没有找到 file 字段' });
  }

  const field = (name) => {
    const hit = parts.find((p) => p.filename === undefined && p.name === name);
    return hit ? hit.data.toString('utf8') : '';
  };

  const original = sanitizeName(filePart.filename);
  const ext = (path.extname(original) || '.m4a').toLowerCase();
  const phone = field('phoneNumber').replace(/[^\d+]/g, '').slice(0, 20);
  const name = `${stamp()}${phone ? `_${phone}` : ''}_${crypto.randomBytes(3).toString('hex')}${ext}`;

  await fsp.writeFile(path.join(DATA_DIR, name), filePart.data);
  const meta = {
    file: name,
    size: filePart.data.length,
    phoneNumber: phone,
    duration: Number(field('duration')) || 0,
    source: field('source'),
    recordedAt: Number(field('recordedAt')) || 0,
    uploadedAt: Date.now(),
  };
  await fsp.writeFile(path.join(DATA_DIR, `${name}.json`), JSON.stringify(meta, null, 2));

  console.log(`[upload] ${name} ${(meta.size / 1024).toFixed(1)}KB phone=${phone || '-'}`);
  return json(res, 200, { ok: true, file: name, size: meta.size, url: `/files/${encodeURIComponent(name)}` });
}

async function handleList(res) {
  const files = await fsp.readdir(DATA_DIR);
  const items = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(DATA_DIR, f), 'utf8'));
      items.push(meta);
    } catch {
      /* 忽略损坏的元数据 */
    }
  }
  items.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
  return json(res, 200, { ok: true, count: items.length, items });
}

function serveFile(req, res, name) {
  const safe = path.basename(decodeURIComponent(name));
  const full = path.join(DATA_DIR, safe);
  if (!full.startsWith(DATA_DIR + path.sep)) return json(res, 403, { ok: false, error: '非法路径' });

  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) return json(res, 404, { ok: false, error: '文件不存在' });
    const ext = path.extname(safe).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? Number(m[1]) : 0;
      let end = m && m[2] ? Number(m[2]) : stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
      });
      return fs.createReadStream(full, { start, end }).pipe(res);
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(safe)}`,
    });
    fs.createReadStream(full).pipe(res);
  });
}

function page(html) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>录音存储</title>
<style>
body{margin:0;background:#0b1220;color:#e6edf7;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 18px 60px}
h1{font-size:18px;margin:0 0 4px}p.sub{color:#8b9bb4;font-size:12.5px;margin:0 0 20px}
.item{background:#141d2e;border:1px solid #22304a;border-radius:12px;padding:12px 14px;margin-bottom:10px}
.name{font-weight:600;word-break:break-all}.meta{color:#8b9bb4;font-size:11.5px;margin-top:3px}
audio{width:100%;margin-top:8px}a{color:#67b0ff;text-decoration:none}
.empty{color:#8b9bb4;text-align:center;padding:40px 0}
</style></head><body><main>${html}</main></body></html>`;
}

async function handleIndex(res) {
  const files = (await fsp.readdir(DATA_DIR)).filter((f) => !f.endsWith('.json'));
  const metas = [];
  for (const f of files) {
    let meta = { file: f };
    try {
      meta = JSON.parse(await fsp.readFile(path.join(DATA_DIR, `${f}.json`), 'utf8'));
    } catch {
      /* 没有元数据也能列出 */
    }
    metas.push(meta);
  }
  metas.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));

  const body = metas.length
    ? metas.map((m) => `
      <div class="item">
        <div class="name">${m.phoneNumber || m.file}</div>
        <div class="meta">${new Date(m.uploadedAt || Date.now()).toLocaleString('zh-CN')} · ${((m.size || 0) / 1024 / 1024).toFixed(2)} MB · <a href="/files/${encodeURIComponent(m.file)}" download>下载</a></div>
        <audio controls preload="none" src="/files/${encodeURIComponent(m.file)}"></audio>
      </div>`).join('')
    : '<div class="empty">还没有录音</div>';

  const html = page(`<h1>录音存储</h1><p class="sub">共 ${metas.length} 个文件 · 上传接口 POST /api/upload</p>${body}`);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/upload') {
    handleUpload(req, res).catch((err) => {
      console.error('[upload] 失败', err);
      json(res, 500, { ok: false, error: '服务器内部错误' });
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/list') {
    handleList(res).catch(() => json(res, 500, { ok: false, error: '服务器内部错误' }));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, service: 'call-upload-api', maxUploadMB: MAX_MB, tokenRequired: Boolean(TOKEN) });
  }
  if (req.method === 'GET' && pathname.startsWith('/files/')) {
    return serveFile(req, res, pathname.slice('/files/'.length));
  }
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    handleIndex(res).catch(() => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('服务器内部错误');
    });
    return;
  }
  json(res, 404, { ok: false, error: '接口不存在' });
});

server.listen(PORT, HOST, () => {
  console.log(`call-upload-api 已启动: http://${HOST}:${PORT}`);
  console.log(`存储目录: ${DATA_DIR}`);
  console.log(`上传令牌: ${TOKEN ? '已启用' : '未启用（任何人都可上传）'}`);
  console.log(`单文件上限: ${MAX_MB}MB`);
});
