// Servidor local do DMI Editor. Sem dependencias externas.
//   node server.js [pasta-raiz] [--port 5175]
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readDmi, writeDmi } from './lib/dmi.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
let PORT = 5175;
let ROOT = path.resolve(HERE, '..'); // por padrao, a pasta acima do editor (ex: Downloads\Byond)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') PORT = Number(argv[++i]);
  else if (argv[i] === '--root') ROOT = path.resolve(argv[++i]);
  else if (!argv[i].startsWith('--')) ROOT = path.resolve(argv[i]);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Impede sair da pasta raiz (o editor grava arquivos; melhor manter a coleira curta).
function safePath(rel) {
  const full = path.resolve(ROOT, rel ?? '.');
  const base = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (full !== ROOT && !full.startsWith(base)) throw new Error('Caminho fora da pasta raiz.');
  return full;
}

function send(req, res, status, body, type = 'application/json; charset=utf-8') {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    buf = zlib.gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(buf);
}

const json = (req, res, status, obj) => send(req, res, status, JSON.stringify(obj));

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// ---- API ----

// Lista subpastas e arquivos .dmi de um diretorio.
async function apiList(req, res, url) {
  const rel = url.searchParams.get('dir') ?? '.';
  const dir = safePath(rel);
  const entries = await fs.readdir(dir, { withFileTypes: true });

  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'target') continue;
    if (e.isDirectory()) dirs.push({ name: e.name, type: 'dir' });
    else if (e.name.toLowerCase().endsWith('.dmi')) files.push({ name: e.name, type: 'dmi' });
  }
  const sort = (a, b) => a.name.localeCompare(b.name);

  json(req, res, 200, {
    root: path.basename(ROOT),
    dir: path.relative(ROOT, dir).split(path.sep).join('/'),
    canGoUp: dir !== ROOT,
    entries: [...dirs.sort(sort), ...files.sort(sort)],
  });
}

async function apiOpen(req, res, url) {
  const rel = url.searchParams.get('path');
  const dmi = await readDmi(safePath(rel));
  json(req, res, 200, {
    path: rel,
    name: dmi.name,
    width: dmi.width,
    height: dmi.height,
    states: dmi.states.map((s) => ({
      name: s.name,
      dirs: s.dirs,
      frameCount: s.frameCount,
      delays: s.delays,
      loop: s.loop,
      rewind: s.rewind,
      movement: s.movement,
      hotspots: s.hotspots,
      // pixels RGBA crus em base64 (1 item por frame*dir) - sem perda, sem canvas no meio
      frames: s.frames.map((f) => f.toString('base64')),
    })),
  });
}

async function apiSave(req, res) {
  const doc = await readBody(req);
  const file = safePath(doc.path);
  if (!file.toLowerCase().endsWith('.dmi')) throw new Error('O arquivo precisa terminar em .dmi');

  const dmi = {
    width: doc.width,
    height: doc.height,
    states: doc.states.map((s) => ({
      ...s,
      frames: s.frames.map((b64) => Buffer.from(b64, 'base64')),
    })),
  };

  for (const s of dmi.states) {
    const expected = s.frameCount * s.dirs;
    if (s.frames.length !== expected) {
      throw new Error(`State "${s.name}": ${s.frames.length} frames, esperado ${expected}.`);
    }
    for (const f of s.frames) {
      if (f.length !== dmi.width * dmi.height * 4) throw new Error(`State "${s.name}": frame com tamanho errado.`);
    }
  }

  const info = await writeDmi(file, dmi);
  json(req, res, 200, { ok: true, ...info });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/list') return await apiList(req, res, url);
    if (url.pathname === '/api/open') return await apiOpen(req, res, url);
    if (url.pathname === '/api/save' && req.method === 'POST') return await apiSave(req, res);

    // estaticos
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(HERE, 'public', rel);
    if (!file.startsWith(path.resolve(HERE, 'public'))) return send(req, res, 403, 'Forbidden', 'text/plain');
    const body = await fs.readFile(file);
    return send(req, res, 200, body, MIME[path.extname(file)] ?? 'application/octet-stream');
  } catch (err) {
    if (err.code === 'ENOENT') return send(req, res, 404, 'Not found', 'text/plain');
    return json(req, res, 400, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  DMI Editor  ->  http://localhost:${PORT}`);
  console.log(`  pasta raiz  ->  ${ROOT}\n`);
});
