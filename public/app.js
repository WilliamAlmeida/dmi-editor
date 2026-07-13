// DMI Editor - frontend. Sem frameworks.
// Modelo: doc.states[i].frames[frame * dirs + dir] = Uint8ClampedArray RGBA (width*height*4)

const $ = (id) => document.getElementById(id);
const DIR_NAMES = ['S', 'N', 'E', 'W', 'SE', 'SW', 'NE', 'NW'];

let doc = null; // { path, name, width, height, states: [...] }
let sel = { s: 0, f: 0, d: 0 };
let cwd = '.';
let zoom = 12;
let tool = 'pencil';
let color = { r: 255, g: 255, b: 255, a: 255 };
let dirty = false;
let clipboard = null;
let stroke = null;

const undoStack = [];
const redoStack = [];

// ---------------------------------------------------------------- utilidades

const curState = () => doc?.states[sel.s];
const fidx = (st, f, d) => f * st.dirs + d;
const curFrame = () => curState()?.frames[fidx(curState(), sel.f, sel.d)];
const blank = () => new Uint8ClampedArray(doc.width * doc.height * 4);

function b64ToPixels(b64) {
  const bin = atob(b64);
  const px = new Uint8ClampedArray(bin.length);
  for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
  return px;
}

function pixelsToB64(px) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < px.length; i += CHUNK) s += String.fromCharCode.apply(null, px.subarray(i, i + CHUNK));
  return btoa(s);
}

const hex2rgb = (h) => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
});
const rgb2hex = (c) => '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');

function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);
}

async function api(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

function setDirty(v = true) {
  dirty = v;
  $('fileTitle').classList.toggle('dirty', v);
}

// ---------------------------------------------------------------- undo/redo

const cloneDoc = () => ({
  ...doc,
  states: doc.states.map((s) => ({
    ...s,
    delays: [...s.delays],
    hotspots: [...s.hotspots],
    frames: s.frames.map((f) => f.slice()),
  })),
});

function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > 150) undoStack.shift();
  redoStack.length = 0;
  setDirty();
  updateUndoButtons();
}

// Aplica a entrada e devolve a inversa (para a outra pilha).
function applyEntry(e) {
  if (e.kind === 'frame') {
    // a pilha tem limite, então um snapshot estrutural pode ter caído fora dela:
    // se o frame não existe mais com o mesmo formato, ignora em vez de quebrar
    const target = doc.states[e.s]?.frames[e.i];
    if (!target || target.length !== e.px.length) return { kind: 'noop' };
    const inv = { kind: 'frame', s: e.s, i: e.i, px: target.slice() };
    target.set(e.px);
    return inv;
  }
  if (e.kind === 'noop') return { kind: 'noop' };
  const inv = { kind: 'doc', doc: cloneDoc(), sel: { ...sel } };
  doc = e.doc;
  sel = e.sel;
  return inv;
}

function undo() {
  const e = undoStack.pop();
  if (!e) return;
  redoStack.push(applyEntry(e));
  setDirty();
  refreshAll();
}

function redo() {
  const e = redoStack.pop();
  if (!e) return;
  undoStack.push(applyEntry(e));
  setDirty();
  refreshAll();
}

function updateUndoButtons() {
  $('btnUndo').disabled = !undoStack.length;
  $('btnRedo').disabled = !redoStack.length;
}

// Envolve mudanças estruturais (states, frames, dirs...) num único passo de undo.
function structural(fn) {
  const before = { kind: 'doc', doc: cloneDoc(), sel: { ...sel } };
  fn();
  pushUndo(before);
  refreshAll();
}

// ---------------------------------------------------------------- pixels

function getPx(px, x, y) {
  const o = (y * doc.width + x) * 4;
  return { r: px[o], g: px[o + 1], b: px[o + 2], a: px[o + 3] };
}

function setPx(px, x, y, c) {
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
  const o = (y * doc.width + x) * 4;
  if (c.a === 0) {
    px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0;
  } else {
    px[o] = c.r;
    px[o + 1] = c.g;
    px[o + 2] = c.b;
    px[o + 3] = c.a;
  }
}

function drawLine(px, x0, y0, x1, y1, c) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    setPx(px, x0, y0, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function drawRect(px, x0, y0, x1, y1, c, filled) {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      if (filled || x === ax || x === bx || y === ay || y === by) setPx(px, x, y, c);
    }
  }
}

function floodFill(px, x, y, c) {
  const target = getPx(px, x, y);
  const same = (p) => p.r === target.r && p.g === target.g && p.b === target.b && p.a === target.a;
  if (same(c) || (target.a === 0 && c.a === 0)) return;

  const stack = [[x, y]];
  const seen = new Uint8Array(doc.width * doc.height);
  while (stack.length) {
    const [cx, cy] = stack.pop();
    if (cx < 0 || cy < 0 || cx >= doc.width || cy >= doc.height) continue;
    const k = cy * doc.width + cx;
    if (seen[k]) continue;
    if (!same(getPx(px, cx, cy))) continue;
    seen[k] = 1;
    setPx(px, cx, cy, c);
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
}

// ---------------------------------------------------------------- render

const off = document.createElement('canvas');
const offCtx = off.getContext('2d', { willReadFrequently: true });

function pixelsToCanvas(px, w, h, canvas) {
  const c = canvas ?? document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(new ImageData(px.slice(), w, h), 0, 0);
  return c;
}

function renderEditor(preview) {
  const cv = $('editor');
  if (!doc) {
    cv.hidden = true;
    $('empty').hidden = false;
    return;
  }
  cv.hidden = false;
  $('empty').hidden = true;

  const px = preview ?? curFrame();
  off.width = doc.width;
  off.height = doc.height;
  offCtx.putImageData(new ImageData(px.slice(), doc.width, doc.height), 0, 0);

  cv.width = doc.width * zoom;
  cv.height = doc.height * zoom;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(off, 0, 0, cv.width, cv.height);

  if ($('showGrid').checked && zoom >= 6) {
    ctx.lineWidth = 1;
    for (let x = 1; x < doc.width; x++) {
      ctx.strokeStyle = x % 8 === 0 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.08)';
      ctx.beginPath();
      ctx.moveTo(x * zoom + 0.5, 0);
      ctx.lineTo(x * zoom + 0.5, cv.height);
      ctx.stroke();
    }
    for (let y = 1; y < doc.height; y++) {
      ctx.strokeStyle = y % 8 === 0 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.08)';
      ctx.beginPath();
      ctx.moveTo(0, y * zoom + 0.5);
      ctx.lineTo(cv.width, y * zoom + 0.5);
      ctx.stroke();
    }
  }

  $('zoomLabel').textContent = `${zoom * 100}%`;
  $('stSize').textContent = `${doc.width}×${doc.height} · zoom ${zoom}x`;
}

function renderStates() {
  const ul = $('stateList');
  ul.innerHTML = '';
  doc?.states.forEach((st, i) => {
    const li = document.createElement('li');
    if (i === sel.s) li.className = 'sel';
    li.append(pixelsToCanvas(st.frames[0], doc.width, doc.height));
    const nm = document.createElement('span');
    nm.className = 'nm' + (st.name ? '' : ' anon');
    nm.textContent = st.name || '(sem nome)';
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${st.dirs}d ${st.frameCount}f`;
    li.append(nm, meta);
    li.onclick = () => {
      sel = { s: i, f: 0, d: 0 };
      refreshAll();
    };
    ul.append(li);
  });
}

function renderGrid() {
  const box = $('grid');
  box.innerHTML = '';
  if (!doc) return;
  const st = curState();

  const table = document.createElement('table');
  const head = table.insertRow();
  head.insertCell().outerHTML = '<th></th>';
  for (let d = 0; d < st.dirs; d++) head.insertCell().outerHTML = `<th>${DIR_NAMES[d]}</th>`;

  for (let f = 0; f < st.frameCount; f++) {
    const row = table.insertRow();
    row.insertCell().outerHTML = `<th>${f + 1}</th>`;
    for (let d = 0; d < st.dirs; d++) {
      const cell = row.insertCell();
      const c = pixelsToCanvas(st.frames[fidx(st, f, d)], doc.width, doc.height);
      if (f === sel.f && d === sel.d) c.className = 'sel';
      c.onclick = () => {
        sel.f = f;
        sel.d = d;
        refreshAll();
      };
      cell.append(c);
    }
  }
  box.append(table);
}

function renderProps() {
  const st = curState();
  if (!st) return;
  $('pName').value = st.name;
  $('pDirs').value = st.dirs;
  $('pFrames').value = st.frameCount;
  $('pDelay').value = st.delays[sel.f] ?? 1;
  $('pDelay').disabled = st.frameCount < 2;
  $('pLoop').value = st.loop;
  $('pRewind').checked = st.rewind;
  $('pMovement').checked = st.movement;
}

function renderPalette() {
  const box = $('palette');
  box.innerHTML = '';
  const base = [
    '#000000', '#ffffff', '#7f7f7f', '#c3c3c3', '#880015', '#ed1c24', '#ff7f27', '#fff200',
    '#22b14c', '#00a2e8', '#3f48cc', '#a349a4', '#b97a57', '#ffaec9', '#ffc90e', '#efe4b0',
    '#b5e61d', '#99d9ea', '#7092be', '#c8bfe7',
  ];
  const used = new Set();
  if (doc) {
    for (const st of doc.states) {
      for (const fr of st.frames) {
        for (let o = 0; o < fr.length; o += 4) {
          if (fr[o + 3] > 0) used.add(rgb2hex({ r: fr[o], g: fr[o + 1], b: fr[o + 2] }));
          if (used.size > 60) break;
        }
      }
    }
  }
  for (const hex of [...new Set([...base, ...used])]) {
    const i = document.createElement('i');
    i.style.background = hex;
    i.title = hex;
    i.onclick = () => {
      color = { ...hex2rgb(hex), a: color.a };
      $('colorPick').value = hex;
    };
    box.append(i);
  }
}

function refreshAll() {
  if (doc) {
    sel.s = Math.min(sel.s, doc.states.length - 1);
    const st = curState();
    sel.f = Math.min(sel.f, st.frameCount - 1);
    sel.d = Math.min(sel.d, st.dirs - 1);
  }
  renderEditor();
  renderStates();
  renderGrid();
  renderProps();
  renderPalette();
  updateUndoButtons();
  $('fileTitle').textContent = doc ? `${doc.path}` : 'nenhum arquivo aberto';
  $('stPath').textContent = doc ? `${doc.states.length} state(s)` : '—';
}

// ---------------------------------------------------------------- arquivos

async function loadDir(dir) {
  const r = await api(`/api/list?dir=${encodeURIComponent(dir)}`);
  cwd = r.dir || '.';
  $('crumbs').innerHTML = `<b>${r.root}</b>${r.dir ? ' / ' + r.dir : ''}`;

  const ul = $('fileList');
  ul.innerHTML = '';
  if (r.canGoUp) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="ico">↰</span> ..';
    li.onclick = () => loadDir(cwd.split('/').slice(0, -1).join('/') || '.');
    ul.append(li);
  }
  for (const e of r.entries) {
    const li = document.createElement('li');
    const path = (cwd === '.' ? '' : cwd + '/') + e.name;
    li.innerHTML = `<span class="ico">${e.type === 'dir' ? '📁' : '🖼'}</span> ${e.name}`;
    if (doc && doc.path === path) li.className = 'sel';
    li.onclick = () => (e.type === 'dir' ? loadDir(path) : openDmi(path));
    ul.append(li);
  }
}

function confirmDiscard() {
  return !dirty || confirm('Há alterações não salvas. Descartar?');
}

async function openDmi(path) {
  if (!confirmDiscard()) return;
  try {
    const d = await api(`/api/open?path=${encodeURIComponent(path)}`);
    d.states.forEach((s) => (s.frames = s.frames.map(b64ToPixels)));
    doc = d;
    sel = { s: 0, f: 0, d: 0 };
    undoStack.length = redoStack.length = 0;
    setDirty(false);
    fitZoom();
    refreshAll();
    loadDir(cwd);
    history.replaceState(null, '', '#' + encodeURIComponent(path)); // link direto p/ o arquivo
  } catch (err) {
    toast(err.message, true);
  }
}

async function save(path = doc?.path) {
  if (!doc) return;
  try {
    const payload = {
      path,
      width: doc.width,
      height: doc.height,
      states: doc.states.map((s) => ({
        name: s.name,
        dirs: s.dirs,
        frameCount: s.frameCount,
        delays: s.delays,
        loop: s.loop,
        rewind: s.rewind,
        movement: s.movement,
        hotspots: s.hotspots,
        frames: s.frames.map(pixelsToB64),
      })),
    };
    const r = await api('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    doc.path = path;
    setDirty(false);
    refreshAll();
    loadDir(cwd);
    toast(`Salvo: ${path} (${r.frames} frames, sheet ${r.sheet})`);
  } catch (err) {
    toast(err.message, true);
  }
}

function fitZoom() {
  const wrap = $('canvasWrap');
  const avail = Math.min(wrap.clientWidth - 60, wrap.clientHeight - 60);
  zoom = Math.max(1, Math.min(32, Math.floor(avail / Math.max(doc.width, doc.height))));
}

// ---------------------------------------------------------------- desenho

function pointerPixel(e) {
  const r = $('editor').getBoundingClientRect();
  return {
    x: Math.floor((e.clientX - r.left) / zoom),
    y: Math.floor((e.clientY - r.top) / zoom),
  };
}

function inBounds(p) {
  return p.x >= 0 && p.y >= 0 && p.x < doc.width && p.y < doc.height;
}

function strokeColor(e) {
  // botão direito ou Shift = apagar
  return e.button === 2 || e.shiftKey ? { r: 0, g: 0, b: 0, a: 0 } : color;
}

$('editor').addEventListener('contextmenu', (e) => e.preventDefault());

$('editor').addEventListener('pointerdown', (e) => {
  if (!doc) return;
  const p = pointerPixel(e);
  if (!inBounds(p)) return;
  $('editor').setPointerCapture(e.pointerId);

  const st = curState();
  const i = fidx(st, sel.f, sel.d);
  const px = st.frames[i];

  if (tool === 'picker' || e.altKey) {
    const c = getPx(px, p.x, p.y);
    if (c.a > 0) {
      color = c;
      $('colorPick').value = rgb2hex(c);
      $('alphaRange').value = c.a;
      $('alphaVal').textContent = c.a;
    }
    return;
  }

  const c = tool === 'eraser' ? { r: 0, g: 0, b: 0, a: 0 } : strokeColor(e);
  const before = px.slice();

  if (tool === 'fill') {
    floodFill(px, p.x, p.y, c);
    pushUndo({ kind: 'frame', s: sel.s, i, px: before });
    renderEditor();
    renderGrid();
    renderStates();
    return;
  }

  stroke = { before, i, s: sel.s, start: p, last: p, c, buf: null };
  if (tool === 'pencil' || tool === 'eraser') setPx(px, p.x, p.y, c);
  renderEditor();
});

$('editor').addEventListener('pointermove', (e) => {
  if (!doc) return;
  const p = pointerPixel(e);
  $('stPixel').textContent = inBounds(p) ? `x ${p.x}  y ${p.y}` : '';

  if (!stroke) return;
  const px = curState().frames[stroke.i];

  if (tool === 'pencil' || tool === 'eraser') {
    drawLine(px, stroke.last.x, stroke.last.y, p.x, p.y, stroke.c);
    stroke.last = p;
    renderEditor();
  } else if (tool === 'line' || tool === 'rect') {
    const buf = stroke.before.slice();
    if (tool === 'line') drawLine(buf, stroke.start.x, stroke.start.y, p.x, p.y, stroke.c);
    else drawRect(buf, stroke.start.x, stroke.start.y, p.x, p.y, stroke.c, $('fillShape').checked);
    stroke.buf = buf;
    renderEditor(buf);
  }
});

$('editor').addEventListener('pointerup', () => {
  if (!stroke) return;
  const px = curState().frames[stroke.i];
  if (stroke.buf) px.set(stroke.buf);
  pushUndo({ kind: 'frame', s: stroke.s, i: stroke.i, px: stroke.before });
  stroke = null;
  renderEditor();
  renderGrid();
  renderStates();
  renderPalette();
});

// ---------------------------------------------------------------- ferramentas / toolbar

function selectTool(t) {
  tool = t;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
}
document.querySelectorAll('.tool').forEach((b) => (b.onclick = () => selectTool(b.dataset.tool)));
selectTool('pencil');

$('colorPick').oninput = (e) => (color = { ...hex2rgb(e.target.value), a: color.a });
$('alphaRange').oninput = (e) => {
  color.a = +e.target.value;
  $('alphaVal').textContent = e.target.value;
};
$('showGrid').onchange = () => renderEditor();

const editFrame = (fn) => {
  const st = curState();
  const i = fidx(st, sel.f, sel.d);
  const before = st.frames[i].slice();
  fn(st.frames[i], before);
  pushUndo({ kind: 'frame', s: sel.s, i, px: before });
  refreshAll();
};

$('btnClear').onclick = () => doc && editFrame((px) => px.fill(0));
$('btnFlipH').onclick = () =>
  doc &&
  editFrame((px, before) => {
    for (let y = 0; y < doc.height; y++)
      for (let x = 0; x < doc.width; x++) {
        const src = (y * doc.width + (doc.width - 1 - x)) * 4;
        px.set(before.subarray(src, src + 4), (y * doc.width + x) * 4);
      }
  });
$('btnFlipV').onclick = () =>
  doc &&
  editFrame((px, before) => {
    for (let y = 0; y < doc.height; y++) {
      const src = (doc.height - 1 - y) * doc.width * 4;
      px.set(before.subarray(src, src + doc.width * 4), y * doc.width * 4);
    }
  });
$('btnCopy').onclick = () => {
  if (!doc) return;
  clipboard = curFrame().slice();
  toast('Frame copiado');
};
$('btnPaste').onclick = () => {
  if (!doc || !clipboard) return;
  if (clipboard.length !== doc.width * doc.height * 4) return toast('Frame de tamanho diferente', true);
  editFrame((px) => px.set(clipboard));
};

$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;
$('btnZoomIn').onclick = () => ((zoom = Math.min(40, zoom + 1)), renderEditor());
$('btnZoomOut').onclick = () => ((zoom = Math.max(1, zoom - 1)), renderEditor());
$('canvasWrap').addEventListener('wheel', (e) => {
  if (!doc || !e.ctrlKey) return;
  e.preventDefault();
  zoom = Math.max(1, Math.min(40, zoom + (e.deltaY < 0 ? 1 : -1)));
  renderEditor();
}, { passive: false });

// ---------------------------------------------------------------- states / frames

$('btnStateAdd').onclick = () =>
  doc &&
  structural(() => {
    doc.states.push({
      name: 'novo',
      dirs: 1,
      frameCount: 1,
      delays: [1],
      loop: 0,
      rewind: false,
      movement: false,
      hotspots: [],
      frames: [blank()],
    });
    sel = { s: doc.states.length - 1, f: 0, d: 0 };
  });

$('btnStateDup').onclick = () =>
  doc &&
  structural(() => {
    const st = curState();
    doc.states.splice(sel.s + 1, 0, {
      ...st,
      delays: [...st.delays],
      hotspots: [...st.hotspots],
      frames: st.frames.map((f) => f.slice()),
    });
    sel.s++;
  });

$('btnStateDel').onclick = () => {
  if (!doc || doc.states.length < 2) return toast('O DMI precisa de pelo menos 1 state', true);
  structural(() => {
    doc.states.splice(sel.s, 1);
    sel = { s: Math.max(0, sel.s - 1), f: 0, d: 0 };
  });
};

const moveState = (dt) => {
  if (!doc) return;
  const j = sel.s + dt;
  if (j < 0 || j >= doc.states.length) return;
  structural(() => {
    [doc.states[sel.s], doc.states[j]] = [doc.states[j], doc.states[sel.s]];
    sel.s = j;
  });
};
$('btnStateUp').onclick = () => moveState(-1);
$('btnStateDown').onclick = () => moveState(1);

function resizeFrames(st, frameCount, dirs) {
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    for (let d = 0; d < dirs; d++) {
      // direção nova (ex: 4 -> 8 dirs) começa como cópia da dir 0 (S), não em branco
      const old = f < st.frameCount ? st.frames[f * st.dirs + (d < st.dirs ? d : 0)] : null;
      frames.push(old ? old.slice() : blank());
    }
  }
  const delays = [];
  for (let f = 0; f < frameCount; f++) delays.push(st.delays[f] ?? st.delays.at(-1) ?? 1);
  st.frames = frames;
  st.frameCount = frameCount;
  st.dirs = dirs;
  st.delays = delays;
}

$('btnFrameAdd').onclick = () => doc && structural(() => {
  const st = curState();
  resizeFrames(st, st.frameCount + 1, st.dirs);
  sel.f = st.frameCount - 1;
});

$('btnFrameDup').onclick = () => doc && structural(() => {
  const st = curState();
  const copy = [];
  for (let d = 0; d < st.dirs; d++) copy.push(st.frames[fidx(st, sel.f, d)].slice());
  st.frames.splice((sel.f + 1) * st.dirs, 0, ...copy);
  st.delays.splice(sel.f + 1, 0, st.delays[sel.f] ?? 1);
  st.frameCount++;
  sel.f++;
});

$('btnFrameDel').onclick = () => {
  if (!doc) return;
  const st = curState();
  if (st.frameCount < 2) return toast('O state precisa de pelo menos 1 frame', true);
  structural(() => {
    st.frames.splice(sel.f * st.dirs, st.dirs);
    st.delays.splice(sel.f, 1);
    st.frameCount--;
    sel.f = Math.max(0, sel.f - 1);
  });
};

// Propriedades. O nome usa snapshot no foco p/ virar 1 passo de undo, não 1 por tecla.
let nameSnap = null;
$('pName').onfocus = () => (nameSnap = { kind: 'doc', doc: cloneDoc(), sel: { ...sel } });
$('pName').oninput = (e) => {
  curState().name = e.target.value;
  renderStates();
  setDirty();
};
$('pName').onchange = () => {
  if (nameSnap) pushUndo(nameSnap);
  nameSnap = null;
};

$('pDirs').onchange = (e) => structural(() => resizeFrames(curState(), curState().frameCount, +e.target.value));
$('pFrames').onchange = (e) => {
  const n = Math.max(1, Math.min(512, +e.target.value));
  structural(() => resizeFrames(curState(), n, curState().dirs));
};
$('pDelay').onchange = (e) => structural(() => (curState().delays[sel.f] = Math.max(0, +e.target.value)));
$('pLoop').onchange = (e) => structural(() => (curState().loop = Math.max(0, +e.target.value)));
$('pRewind').onchange = (e) => structural(() => (curState().rewind = e.target.checked));
$('pMovement').onchange = (e) => structural(() => (curState().movement = e.target.checked));

// ---------------------------------------------------------------- novo / salvar

$('btnNew').onclick = () => {
  if (!confirmDiscard()) return;
  $('dlgNew').showModal();
};

$('dlgNew').addEventListener('close', () => {
  if ($('dlgNew').returnValue !== 'ok') return;
  const name = $('nName').value.trim().replace(/\.dmi$/i, '') || 'novo';
  const w = Math.max(1, Math.min(512, +$('nW').value));
  const h = Math.max(1, Math.min(512, +$('nH').value));
  doc = {
    path: (cwd === '.' ? '' : cwd + '/') + name + '.dmi',
    name,
    width: w,
    height: h,
    states: [
      { name: '', dirs: 1, frameCount: 1, delays: [1], loop: 0, rewind: false, movement: false, hotspots: [], frames: [] },
    ],
  };
  doc.states[0].frames = [blank()];
  sel = { s: 0, f: 0, d: 0 };
  undoStack.length = redoStack.length = 0;
  setDirty(true);
  fitZoom();
  refreshAll();
});

$('btnSave').onclick = () => save();
$('btnSaveAs').onclick = () => {
  if (!doc) return;
  const name = prompt('Salvar como (caminho relativo à raiz):', doc.path);
  if (name) save(name.endsWith('.dmi') ? name : name + '.dmi');
};

// ---------------------------------------------------------------- animação

let playing = true;
$('btnPlay').onclick = () => {
  playing = !playing;
  $('btnPlay').innerHTML = playing ? '&#9654;' : '&#10073;&#10073;';
};

function previewLoop() {
  requestAnimationFrame(previewLoop);
  if (!doc) return;
  const st = curState();
  const cv = $('preview');
  cv.width = doc.width;
  cv.height = doc.height;

  let f = sel.f;
  if (playing && st.frameCount > 1) {
    // delays em décimos de segundo (1 = 0,1s), igual à BYOND
    const seq = [...Array(st.frameCount).keys()];
    if (st.rewind) seq.push(...seq.slice(1, -1).reverse());
    const total = seq.reduce((n, i) => n + Math.max(0.1, st.delays[i] ?? 1), 0);
    let t = ((performance.now() / 100) % total);
    for (const i of seq) {
      t -= Math.max(0.1, st.delays[i] ?? 1);
      if (t <= 0) { f = i; break; }
    }
  }
  const px = st.frames[fidx(st, f, sel.d)];
  cv.getContext('2d').putImageData(new ImageData(px.slice(), doc.width, doc.height), 0, 0);
}
requestAnimationFrame(previewLoop);

// ---------------------------------------------------------------- teclado

document.addEventListener('keydown', (e) => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;

  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); save(); }
    else if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    else if (k === 'c') $('btnCopy').click();
    else if (k === 'v') $('btnPaste').click();
    return;
  }

  const tools = { b: 'pencil', e: 'eraser', g: 'fill', i: 'picker', l: 'line', r: 'rect' };
  if (tools[e.key]) return selectTool(tools[e.key]);
  if (e.key === 'Delete') return $('btnClear').click();
  if (!doc) return;

  const st = curState();
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    sel.f = (sel.f + (e.key === 'ArrowRight' ? 1 : -1) + st.frameCount) % st.frameCount;
    refreshAll();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    sel.d = (sel.d + (e.key === 'ArrowDown' ? 1 : -1) + st.dirs) % st.dirs;
    refreshAll();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

// ---------------------------------------------------------------- boot

const initial = decodeURIComponent(location.hash.slice(1));
const startDir = initial.includes('/') ? initial.split('/').slice(0, -1).join('/') : '.';
await loadDir(startDir);
if (initial) await openDmi(initial);
refreshAll();
