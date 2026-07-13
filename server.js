// Servidor local do DMI Editor. Sem dependencias externas.
//   node server.js [pasta-raiz] [--port 5175]
//
// Frames trafegam num envelope binario (evita base64/JSON em arquivos grandes):
//   "DMIB" | u32LE tamanho do JSON | JSON (header) | pixels RGBA crus concatenados
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readDmi, writeDmi } from './lib/dmi.js';
import { decodePng, encodePng } from './lib/png.js';
import { encodeGif } from './lib/gif.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAGIC = 'DMIB';

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

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const readJson = async (req) => JSON.parse((await readRaw(req)).toString('utf8'));

function packEnvelope(header, pixelBuffers) {
  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const head = Buffer.alloc(8);
  head.write(MAGIC, 0, 'latin1');
  head.writeUInt32LE(jsonBuf.length, 4);
  return Buffer.concat([head, jsonBuf, ...pixelBuffers]);
}

function unpackEnvelope(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== MAGIC) throw new Error('Envelope binário inválido.');
  const jsonLen = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + jsonLen));
  return { header, pixels: buf.subarray(8 + jsonLen) };
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

// mtime do arquivo (deteccao de mudanca externa)
async function apiStat(req, res, url) {
  const file = safePath(url.searchParams.get('path'));
  try {
    const st = await fs.stat(file);
    json(req, res, 200, { mtimeMs: st.mtimeMs });
  } catch {
    json(req, res, 200, { mtimeMs: null });
  }
}

async function apiOpen(req, res, url) {
  const rel = url.searchParams.get('path');
  const file = safePath(rel);
  const dmi = await readDmi(file);
  const stat = await fs.stat(file);

  const header = {
    path: rel,
    name: dmi.name,
    width: dmi.width,
    height: dmi.height,
    mtimeMs: stat.mtimeMs,
    states: dmi.states.map((s) => ({
      name: s.name,
      dirs: s.dirs,
      frameCount: s.frameCount,
      delays: s.delays,
      loop: s.loop,
      rewind: s.rewind,
      movement: s.movement,
      hotspots: s.hotspots,
    })),
  };
  send(req, res, 200, packEnvelope(header, dmi.states.flatMap((s) => s.frames)), 'application/octet-stream');
}

async function apiSave(req, res) {
  const { header, pixels } = unpackEnvelope(await readRaw(req));
  const file = safePath(header.path);
  if (!file.toLowerCase().endsWith('.dmi')) throw new Error('O arquivo precisa terminar em .dmi');

  // conflito: alguem gravou o arquivo desde que o editor abriu?
  let mtime = null;
  try {
    mtime = (await fs.stat(file)).mtimeMs;
  } catch {}
  if (mtime !== null && header.expectedMtime != null && !header.force && Math.abs(mtime - header.expectedMtime) > 0.001) {
    return json(req, res, 409, { error: 'O arquivo mudou no disco desde que foi aberto.', conflict: true });
  }

  const frameBytes = header.width * header.height * 4;
  const dmi = { width: header.width, height: header.height, states: [] };
  let off = 0;
  for (const s of header.states) {
    const n = s.frameCount * s.dirs;
    const frames = [];
    for (let i = 0; i < n; i++) {
      frames.push(pixels.subarray(off, off + frameBytes));
      off += frameBytes;
    }
    if (frames.some((f) => f.length !== frameBytes)) throw new Error(`State "${s.name}": pixels faltando.`);
    dmi.states.push({ ...s, frames });
  }
  if (off !== pixels.length) throw new Error('Tamanho do corpo não bate com a metadata.');

  if (mtime !== null) await fs.copyFile(file, file + '.bak'); // backup antes de sobrescrever

  const info = await writeDmi(file, dmi);
  const stat = await fs.stat(file);
  json(req, res, 200, { ok: true, mtimeMs: stat.mtimeMs, ...info });
}

// PNG cru -> RGBA (decodificado no servidor com nosso codec: sem perda de canvas)
async function apiImportPng(req, res) {
  const png = decodePng(await readRaw(req));
  send(
    req,
    res,
    200,
    packEnvelope({ width: png.width, height: png.height }, [Buffer.from(png.data)]),
    'application/octet-stream'
  );
}

// header: { width, height, delays: [cs...], loop, count }; pixels = frames concatenados
async function apiExportGif(req, res) {
  const { header, pixels } = unpackEnvelope(await readRaw(req));
  const frameBytes = header.width * header.height * 4;
  const frames = [];
  for (let i = 0; i < header.count; i++) frames.push(pixels.subarray(i * frameBytes, (i + 1) * frameBytes));
  const gif = encodeGif({
    width: header.width,
    height: header.height,
    frames,
    delays: header.delays ?? [],
    loop: header.loop ?? 0,
  });
  send(req, res, 200, gif, 'image/gif');
}

// header: { width, height, count, cols } ou { ..., positions: [{x,y}] em células }.
// Monta a folha e devolve PNG.
async function apiExportPng(req, res) {
  const { header, pixels } = unpackEnvelope(await readRaw(req));
  const { width, height, count } = header;
  const frameBytes = width * height * 4;

  let positions = header.positions;
  if (!positions) {
    const cols = Math.max(1, header.cols ?? count);
    positions = Array.from({ length: count }, (_, i) => ({ x: i % cols, y: Math.floor(i / cols) }));
  }
  const sheetW = (Math.max(...positions.map((p) => p.x)) + 1) * width;
  const sheetH = (Math.max(...positions.map((p) => p.y)) + 1) * height;

  const sheet = Buffer.alloc(sheetW * sheetH * 4);
  for (let i = 0; i < count; i++) {
    const frame = pixels.subarray(i * frameBytes, (i + 1) * frameBytes);
    const x0 = positions[i].x * width;
    const y0 = positions[i].y * height;
    for (let y = 0; y < height; y++) {
      frame.copy(sheet, ((y0 + y) * sheetW + x0) * 4, y * width * 4, (y + 1) * width * 4);
    }
  }
  send(req, res, 200, encodePng({ width: sheetW, height: sheetH, data: sheet }), 'image/png');
}

// ---- operacoes de arquivo (renomear / duplicar / excluir) ----

async function apiFileRename(req, res) {
  const { from, to } = await readJson(req);
  const src = safePath(from);
  const dst = safePath(to);
  if (!dst.toLowerCase().endsWith('.dmi')) throw new Error('O nome precisa terminar em .dmi');
  try {
    await fs.access(dst);
    throw new Error('Já existe um arquivo com esse nome.');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await fs.rename(src, dst);
  json(req, res, 200, { ok: true, path: to });
}

async function apiFileDuplicate(req, res) {
  const { path: rel, toDir } = await readJson(req);
  const src = safePath(rel);
  const dir = safePath(toDir ?? (rel.split('/').slice(0, -1).join('/') || '.'));
  const base = rel.split('/').pop().replace(/\.dmi$/i, '');
  let target, n = 0;
  do {
    target = path.join(dir, `${base}_copia${n ? n + 1 : ''}.dmi`);
    n++;
  } while (await fs.access(target).then(() => true).catch(() => false));
  await fs.copyFile(src, target);
  json(req, res, 200, { ok: true, path: path.relative(ROOT, target).split(path.sep).join('/') });
}

async function apiFileDelete(req, res) {
  const { path: rel } = await readJson(req);
  const file = safePath(rel);
  if (!file.toLowerCase().endsWith('.dmi')) throw new Error('Só arquivos .dmi podem ser excluídos por aqui.');
  await fs.rm(file);
  json(req, res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/list') return await apiList(req, res, url);
    if (url.pathname === '/api/stat') return await apiStat(req, res, url);
    if (url.pathname === '/api/open') return await apiOpen(req, res, url);
    if (url.pathname === '/api/save' && req.method === 'POST') return await apiSave(req, res);
    if (url.pathname === '/api/import/png' && req.method === 'POST') return await apiImportPng(req, res);
    if (url.pathname === '/api/export/gif' && req.method === 'POST') return await apiExportGif(req, res);
    if (url.pathname === '/api/export/png' && req.method === 'POST') return await apiExportPng(req, res);
    if (url.pathname === '/api/file/rename' && req.method === 'POST') return await apiFileRename(req, res);
    if (url.pathname === '/api/file/duplicate' && req.method === 'POST') return await apiFileDuplicate(req, res);
    if (url.pathname === '/api/file/delete' && req.method === 'POST') return await apiFileDelete(req, res);

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
