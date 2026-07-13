// DMI Editor - frontend. Sem frameworks.
// Modelo: doc.states[i].frames[frame * dirs + dir] = Uint8ClampedArray RGBA (width*height*4)
import * as P from './pixels.js';
import { encodeEnvelope, decodeEnvelope } from './binio.js';

const $ = (id) => document.getElementById(id);
const DIR_NAMES = ['S', 'N', 'E', 'W', 'SE', 'SW', 'NE', 'NW'];
const UNDO_CAP = 200 * 1024 * 1024; // bytes por aba

// ---------------------------------------------------------------- estado (por aba)

const tabs = [];
let tabIdx = -1;

let doc = null; // { path, name, width, height, mtimeMs, states }
let sel = { s: 0, f: 0, d: 0 };
let undoStack = [], redoStack = [];
let undoBytes = 0, redoBytes = 0;
let dirty = false;
let zoom = 12;
let selRect = null;      // { x, y, w, h }
let floating = null;     // { px, w, h, x, y }
let floatSnap = null;    // { before, cut }
let docColors = [];
let extChanged = false;  // mudou no disco enquanto havia edicao local

let cwd = '.';
let tool = 'pencil';
let color = { r: 255, g: 255, b: 255, a: 255 };
let gridSel = new Set(); // multi-seleção de frames na grade ("f:d"), do state atual
let hoveredFile = null;  // arquivo sob o mouse na lista (p/ F2/Del/Ctrl+C)
let filesHover = false;
let fileClip = null;     // arquivo "copiado" com Ctrl+C na lista
let ctxTarget = null;    // arquivo do menu de contexto
let clipboard = null;      // { px, w, h } - regiao
let stateClipboard = null; // { state, width, height } - state inteiro (entre abas)
let stroke = null;
let dragSel = null;
let playing = true;
let hueBase = null;
let pendingImport = null;

const TAB_FIELDS = [
  'doc', 'sel', 'undoStack', 'redoStack', 'undoBytes', 'redoBytes', 'dirty',
  'zoom', 'selRect', 'floating', 'floatSnap', 'docColors', 'extChanged',
];

function snapshotTab() {
  if (tabIdx < 0) return;
  Object.assign(tabs[tabIdx], { doc, sel, undoStack, redoStack, undoBytes, redoBytes, dirty, zoom, selRect, floating, floatSnap, docColors, extChanged });
}

function activateTab(i) {
  snapshotTab();
  gridSel.clear();
  tabIdx = i;
  if (i < 0) {
    doc = null; sel = { s: 0, f: 0, d: 0 };
    undoStack = []; redoStack = []; undoBytes = redoBytes = 0;
    dirty = false; selRect = floating = floatSnap = null; docColors = []; extChanged = false;
  } else {
    const t = tabs[i];
    ({ doc, sel, undoStack, redoStack, undoBytes, redoBytes, dirty, zoom, selRect, floating, floatSnap, docColors, extChanged } = t);
    history.replaceState(null, '', '#' + encodeURIComponent(doc.path));
  }
  renderTabs();
  refreshAll();
  refreshFileSel();
}

function newTab(tabDoc) {
  snapshotTab();
  tabs.push({
    doc: tabDoc, sel: { s: 0, f: 0, d: 0 },
    undoStack: [], redoStack: [], undoBytes: 0, redoBytes: 0,
    dirty: false, zoom: 12, selRect: null, floating: null, floatSnap: null,
    docColors: collectDocColors(tabDoc), extChanged: false,
  });
  activateTab(tabs.length - 1);
  fitZoom();
  renderEditor();
}

function closeTab(i) {
  if (tabs[i].dirty && !confirm(`"${tabName(tabs[i])}" tem alterações não salvas. Fechar mesmo assim?`)) return;
  const wasActive = i === tabIdx;
  tabs.splice(i, 1);
  if (tabIdx > i) tabIdx--;
  if (wasActive) {
    tabIdx = -1;
    activateTab(tabs.length ? Math.min(i, tabs.length - 1) : -1);
  } else {
    renderTabs();
  }
}

const tabName = (t) => t.doc.path.split('/').pop();

function renderTabs() {
  const bar = $('tabbar');
  bar.hidden = !tabs.length;
  bar.innerHTML = '';
  tabs.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'tab' + (i === tabIdx ? ' active' : '') + (t.dirty || (i === tabIdx && dirty) ? ' dirty' : '');
    el.title = t.doc.path;
    const nm = document.createElement('span');
    nm.textContent = tabName(t);
    const x = document.createElement('b');
    x.textContent = '×';
    x.onclick = (e) => { e.stopPropagation(); closeTab(i); };
    el.append(nm, x);
    el.onclick = () => { if (i !== tabIdx) activateTab(i); };
    bar.append(el);
  });
}

// ---------------------------------------------------------------- utilidades

const curState = () => doc?.states[sel.s];
const fidx = (st, f, d) => f * st.dirs + d;
const curFrame = () => curState()?.frames[fidx(curState(), sel.f, sel.d)];
const blank = () => new Uint8ClampedArray(doc.width * doc.height * 4);
const brush = () => Math.max(1, Math.min(16, +$('brushSize').value || 1));

// indices de frame alvo de efeitos: a multi-seleção da grade, ou só o frame atual
function targetFrames() {
  const st = curState();
  if (gridSel.size) {
    return [...gridSel].map((k) => {
      const [f, d] = k.split(':').map(Number);
      return fidx(st, f, d);
    });
  }
  return [fidx(st, sel.f, sel.d)];
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
  toast._t = setTimeout(() => (el.hidden = true), 3200);
}

async function apiJson(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json();
  if (!r.ok) { body.status = r.status; throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), body); }
  return body;
}

function setDirty(v = true) {
  dirty = v;
  if (tabIdx >= 0) tabs[tabIdx].dirty = v;
  renderTabs();
}

function collectDocColors(d) {
  const seen = new Set();
  outer: for (const st of d.states) {
    for (const fr of st.frames) {
      for (let o = 0; o < fr.length; o += 4) {
        if (fr[o + 3] > 0) {
          seen.add(rgb2hex({ r: fr[o], g: fr[o + 1], b: fr[o + 2] }));
          if (seen.size >= 36) break outer;
        }
      }
    }
  }
  return [...seen];
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

const entryBytes = (e) =>
  e.kind === 'frame' ? e.px.length + 64
  : e.kind === 'meta' || e.kind === 'noop' ? 256
  : e.doc.states.reduce((n, s) => n + s.frames.length, 0) * e.doc.width * e.doc.height * 4 + 1024;

function pushUndo(entry) {
  undoStack.push(entry);
  undoBytes += entryBytes(entry);
  redoStack.length = 0;
  redoBytes = 0;
  while ((undoBytes > UNDO_CAP || undoStack.length > 400) && undoStack.length > 1) {
    undoBytes -= entryBytes(undoStack.shift());
  }
  setDirty();
  updateUndoButtons();
}

// Aplica a entrada e devolve a inversa (para a outra pilha).
function applyEntry(e) {
  if (e.kind === 'noop') return { kind: 'noop' };
  if (e.kind === 'frame') {
    const target = doc.states[e.s]?.frames[e.i];
    if (!target || target.length !== e.px.length) return { kind: 'noop' };
    const inv = { kind: 'frame', s: e.s, i: e.i, px: target.slice() };
    target.set(e.px);
    return inv;
  }
  if (e.kind === 'meta') {
    const st = doc.states[e.s];
    if (!st) return { kind: 'noop' };
    const inv = { kind: 'meta', s: e.s, props: {} };
    for (const k of Object.keys(e.props)) inv.props[k] = Array.isArray(st[k]) ? [...st[k]] : st[k];
    Object.assign(st, e.props);
    return inv;
  }
  const inv = { kind: 'doc', doc: cloneDoc(), sel: { ...sel } };
  doc = e.doc;
  sel = e.sel;
  if (tabIdx >= 0) tabs[tabIdx].doc = doc;
  return inv;
}

function undo() {
  const e = undoStack.pop();
  if (!e) return;
  undoBytes -= entryBytes(e);
  cancelFloatSilent();
  const inv = applyEntry(e);
  redoStack.push(inv);
  redoBytes += entryBytes(inv);
  setDirty();
  refreshAll();
}

function redo() {
  const e = redoStack.pop();
  if (!e) return;
  redoBytes -= entryBytes(e);
  cancelFloatSilent();
  const inv = applyEntry(e);
  undoStack.push(inv);
  undoBytes += entryBytes(inv);
  setDirty();
  refreshAll();
}

function updateUndoButtons() {
  $('btnUndo').disabled = !undoStack.length;
  $('btnRedo').disabled = !redoStack.length;
}

// Mudanças estruturais (states, frames, dirs, tamanho...) = 1 snapshot do doc inteiro.
function structural(fn) {
  commitFloatIfAny();
  selRect = null;
  const before = { kind: 'doc', doc: cloneDoc(), sel: { ...sel } };
  fn();
  pushUndo(before);
  refreshAll();
}

// Mudanças só de metadata do state (nome, delay, flags) = entrada leve.
function metaEdit(patch) {
  const st = curState();
  const inv = {};
  for (const k of Object.keys(patch)) inv[k] = Array.isArray(st[k]) ? [...st[k]] : st[k];
  Object.assign(st, patch);
  pushUndo({ kind: 'meta', s: sel.s, props: inv });
}

// Edicao de um frame com undo + refresh leve.
function editFrame(fn) {
  const st = curState();
  const i = fidx(st, sel.f, sel.d);
  const before = st.frames[i].slice();
  fn(st.frames[i], before);
  pushUndo({ kind: 'frame', s: sel.s, i, px: before });
  lightRefresh();
}

function lightRefresh() {
  renderEditor();
  repaintThumb(sel.s);
  repaintGridCell(sel.f, sel.d);
}

// ---------------------------------------------------------------- selecao

const symOn = () => $('symChk').checked;
const mirrorX = (x) => doc.width - 1 - x;

function commitFloatIfAny() {
  if (!floating) return;
  const st = curState();
  const i = fidx(st, sel.f, sel.d);
  P.blitOver(st.frames[i], doc.width, doc.height, floating.px, floating.w, floating.h, floating.x, floating.y);
  pushUndo({ kind: 'frame', s: sel.s, i, px: floatSnap.before });
  floating = floatSnap = null;
  lightRefresh();
}

function cancelFloatSilent() {
  // desfaz o lift sem entrada de undo (usado por undo/redo e Esc)
  if (!floating) return;
  const st = curState();
  st.frames[fidx(st, sel.f, sel.d)].set(floatSnap.before);
  floating = floatSnap = null;
}

function liftSelection(copy) {
  const st = curState();
  const i = fidx(st, sel.f, sel.d);
  const px = st.frames[i];
  floatSnap = { before: px.slice(), cut: !copy };
  floating = {
    px: P.copyRegion(px, doc.width, doc.height, selRect.x, selRect.y, selRect.w, selRect.h),
    w: selRect.w, h: selRect.h, x: selRect.x, y: selRect.y,
  };
  if (!copy) P.clearRegion(px, doc.width, doc.height, selRect.x, selRect.y, selRect.w, selRect.h);
}

function deleteSelection() {
  if (!doc) return;
  if (floating) {
    const st = curState();
    const i = fidx(st, sel.f, sel.d);
    if (floatSnap.cut) pushUndo({ kind: 'frame', s: sel.s, i, px: floatSnap.before });
    floating = floatSnap = null;
    selRect = null;
    lightRefresh();
    return;
  }
  if (selRect) {
    const r = selRect;
    editFrame((px) => P.clearRegion(px, doc.width, doc.height, r.x, r.y, r.w, r.h));
    return;
  }
  if (gridSel.size) {
    const targets = targetFrames();
    structural(() => {
      const st = curState();
      for (const i of targets) st.frames[i].fill(0);
    });
    return;
  }
  editFrame((px) => px.fill(0));
}

function copySel(cut = false) {
  if (!doc) return;
  if (floating) {
    clipboard = { px: floating.px.slice(), w: floating.w, h: floating.h };
    if (cut) deleteSelection();
    toast(`Copiado ${clipboard.w}×${clipboard.h}`);
    return;
  }
  const st = curState();
  const px = st.frames[fidx(st, sel.f, sel.d)];
  const r = selRect ?? { x: 0, y: 0, w: doc.width, h: doc.height };
  clipboard = { px: P.copyRegion(px, doc.width, doc.height, r.x, r.y, r.w, r.h), w: r.w, h: r.h };
  if (cut) {
    editFrame((p) => P.clearRegion(p, doc.width, doc.height, r.x, r.y, r.w, r.h));
  }
  toast(`Copiado ${r.w}×${r.h}`);
}

function pasteRegion() {
  if (!doc || !clipboard) return;
  commitFloatIfAny();
  const st = curState();
  floatSnap = { before: st.frames[fidx(st, sel.f, sel.d)].slice(), cut: false };
  const x = Math.round((doc.width - clipboard.w) / 2);
  const y = Math.round((doc.height - clipboard.h) / 2);
  floating = { px: clipboard.px.slice(), w: clipboard.w, h: clipboard.h, x, y };
  selRect = { x, y, w: clipboard.w, h: clipboard.h };
  selectTool('select');
  renderEditor();
}

function nudge(dx, dy) {
  if (floating) {
    floating.x += dx;
    floating.y += dy;
  } else if (selRect) {
    liftSelection(false);
    floating.x += dx;
    floating.y += dy;
  } else return false;
  selRect = { x: floating.x, y: floating.y, w: floating.w, h: floating.h };
  renderEditor();
  return true;
}

// ---------------------------------------------------------------- render: editor

const off = document.createElement('canvas');
const offCtx = off.getContext('2d');

function layerCanvas(px, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(new ImageData(px.slice(), w, h), 0, 0);
  return c;
}

function pixelsToCanvas(px, w, h, canvas) {
  const c = canvas ?? document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(new ImageData(px.slice(), w, h), 0, 0);
  return c;
}

function renderEditor(previewBuf) {
  const cv = $('editor');
  if (!doc) {
    cv.hidden = true;
    $('empty').hidden = false;
    $('stSize').textContent = '';
    return;
  }
  cv.hidden = false;
  $('empty').hidden = true;

  const st = curState();
  const W = doc.width, H = doc.height;

  off.width = W;
  off.height = H;
  offCtx.clearRect(0, 0, W, H);

  // onion skin: frame anterior/proximo como fantasma
  if ($('onionChk').checked && st.frameCount > 1) {
    const prev = st.frames[fidx(st, (sel.f - 1 + st.frameCount) % st.frameCount, sel.d)];
    const next = st.frames[fidx(st, (sel.f + 1) % st.frameCount, sel.d)];
    offCtx.globalAlpha = 0.3;
    offCtx.drawImage(layerCanvas(prev, W, H), 0, 0);
    if (st.frameCount > 2) {
      offCtx.globalAlpha = 0.15;
      offCtx.drawImage(layerCanvas(next, W, H), 0, 0);
    }
    offCtx.globalAlpha = 1;
  }

  offCtx.drawImage(layerCanvas(previewBuf ?? curFrame(), W, H), 0, 0);
  if (floating) offCtx.drawImage(layerCanvas(floating.px, floating.w, floating.h), floating.x, floating.y);

  cv.width = W * zoom;
  cv.height = H * zoom;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(off, 0, 0, cv.width, cv.height);

  if ($('showGrid').checked && zoom >= 6) {
    ctx.lineWidth = 1;
    for (let x = 1; x < W; x++) {
      ctx.strokeStyle = x % 8 === 0 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.08)';
      ctx.beginPath();
      ctx.moveTo(x * zoom + 0.5, 0);
      ctx.lineTo(x * zoom + 0.5, cv.height);
      ctx.stroke();
    }
    for (let y = 1; y < H; y++) {
      ctx.strokeStyle = y % 8 === 0 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.08)';
      ctx.beginPath();
      ctx.moveTo(0, y * zoom + 0.5);
      ctx.lineTo(cv.width, y * zoom + 0.5);
      ctx.stroke();
    }
  }

  if (symOn() && zoom >= 2) {
    ctx.strokeStyle = 'rgba(110,231,183,.4)';
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo((W / 2) * zoom + 0.5, 0);
    ctx.lineTo((W / 2) * zoom + 0.5, cv.height);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (selRect) {
    const phase = (performance.now() / 60) % 8;
    const X = selRect.x * zoom + 0.5;
    const Y = selRect.y * zoom + 0.5;
    const RW = selRect.w * zoom - 1;
    const RH = selRect.h * zoom - 1;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#000';
    ctx.lineDashOffset = -phase;
    ctx.strokeRect(X, Y, RW, RH);
    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = -phase + 4;
    ctx.strokeRect(X, Y, RW, RH);
    ctx.setLineDash([]);
  }

  $('zoomLabel').textContent = `${zoom * 100}%`;
  $('stSize').textContent = `${W}×${H} · zoom ${zoom}x`;
  $('stSel').textContent = selRect
    ? `sel ${selRect.w}×${selRect.h}`
    : gridSel.size ? `${gridSel.size} frame(s) selecionado(s)` : '';
}

// ---------------------------------------------------------------- render: paineis

let thumbObs = null;

function paintThumb(canvas) {
  const st = doc?.states[+canvas.dataset.s];
  if (st) pixelsToCanvas(st.frames[0], doc.width, doc.height, canvas);
}

function repaintThumb(s) {
  const c = $('stateList').querySelector(`canvas[data-s="${s}"]`);
  if (c) paintThumb(c);
}

function renderStates() {
  const ul = $('stateList');
  thumbObs?.disconnect();
  ul.innerHTML = '';
  if (!doc) return;

  thumbObs = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          paintThumb(en.target);
          thumbObs.unobserve(en.target);
        }
      }
    },
    { root: ul }
  );

  const q = $('stateSearch').value.trim().toLowerCase();
  doc.states.forEach((st, i) => {
    if (q && !st.name.toLowerCase().includes(q)) return;
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.s = i;
    if (i === sel.s) li.className = 'sel';

    const c = document.createElement('canvas');
    c.dataset.s = i;
    c.width = doc.width;
    c.height = doc.height;
    thumbObs.observe(c);

    const nm = document.createElement('span');
    nm.className = 'nm' + (st.name ? '' : ' anon');
    nm.textContent = st.name || '(sem nome)';
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${st.dirs}d ${st.frameCount}f`;
    li.append(c, nm, meta);

    li.onclick = () => navTo({ s: i, f: 0, d: 0 });
    li.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', String(i)));
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      li.classList.add('dropping');
    });
    li.addEventListener('dragleave', () => li.classList.remove('dropping'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      li.classList.remove('dropping');
      const from = +e.dataTransfer.getData('text/plain');
      if (Number.isNaN(from) || from === i) return;
      structural(() => {
        const [moved] = doc.states.splice(from, 1);
        doc.states.splice(i, 0, moved);
        sel = { s: i, f: 0, d: 0 };
      });
    });
    ul.append(li);
  });
}

function repaintGridCell(f, d) {
  const c = $('grid').querySelector(`canvas[data-f="${f}"][data-d="${d}"]`);
  if (c) {
    const st = curState();
    pixelsToCanvas(st.frames[fidx(st, f, d)], doc.width, doc.height, c);
  }
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
      c.dataset.f = f;
      c.dataset.d = d;
      const key = `${f}:${d}`;
      if (gridSel.has(key)) c.classList.add('multi');
      if (f === sel.f && d === sel.d) c.classList.add('sel');
      c.title = 'Ctrl+clique: selecionar vários frames p/ aplicar efeitos só neles';
      c.onclick = (e) => {
        if (e.ctrlKey || e.metaKey) {
          if (!gridSel.size) gridSel.add(`${sel.f}:${sel.d}`); // inclui o atual na 1ª vez
          if (gridSel.has(key)) gridSel.delete(key);
          else gridSel.add(key);
          if (gridSel.size === 1 && gridSel.has(`${sel.f}:${sel.d}`)) gridSel.clear();
          renderGrid();
          renderEditor();
          return;
        }
        gridSel.clear();
        navTo({ f, d });
      };
      cell.append(c);
    }
  }
  box.append(table);
}

function renderProps() {
  const st = curState();
  const dis = !st;
  for (const id of ['pName', 'pDirs', 'pFrames', 'pDelay', 'pLoop', 'pRewind', 'pMovement', 'dcFrom', 'dcTo', 'btnDirCopy']) {
    $(id).disabled = dis;
  }
  if (!st) {
    $('pName').value = '';
    $('scrub').value = 0;
    $('scrub').max = 0;
    $('scrub').disabled = true;
    $('scrubLabel').textContent = '—';
    return;
  }
  $('pName').value = st.name;
  $('pDirs').value = st.dirs;
  $('pFrames').value = st.frameCount;
  $('pDelay').value = st.delays[sel.f] ?? 1;
  $('pDelay').disabled = st.frameCount < 2;
  $('pLoop').value = st.loop;
  $('pRewind').checked = st.rewind;
  $('pMovement').checked = st.movement;

  for (const id of ['dcFrom', 'dcTo']) {
    const s = $(id);
    const cur = s.value;
    s.innerHTML = '';
    for (let d = 0; d < st.dirs; d++) s.add(new Option(DIR_NAMES[d], d));
    if (cur && +cur < st.dirs) s.value = cur;
  }
  $('dcFrom').disabled = $('dcTo').disabled = $('btnDirCopy').disabled = st.dirs < 2;

  const scrub = $('scrub');
  scrub.max = st.frameCount - 1;
  scrub.value = sel.f;
  scrub.disabled = st.frameCount < 2;
  $('scrubLabel').textContent = `${sel.f + 1}/${st.frameCount}`;
}

// ---------------------------------------------------------------- paleta

const lsGet = (k, def) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; }
};
const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));

function paletteGroup(box, title, entries, storeKey) {
  if (!entries.length) return;
  const lbl = document.createElement('span');
  lbl.className = 'pal-label';
  lbl.textContent = title;
  box.append(lbl);
  for (const e of entries) {
    const hex = typeof e === 'string' ? e : e.hex;
    const a = typeof e === 'string' ? 255 : e.a;
    const i = document.createElement('i');
    i.style.background = hex;
    if (a < 255) i.style.opacity = Math.max(0.25, a / 255);
    i.title = hex + (a < 255 ? ` (alfa ${a})` : '') + (storeKey ? ' — botão direito remove' : '');
    i.onclick = () => {
      color = { ...hex2rgb(hex), a };
      $('colorPick').value = hex;
      $('alphaRange').value = a;
      $('alphaVal').textContent = a;
    };
    if (storeKey) {
      i.oncontextmenu = (ev) => {
        ev.preventDefault();
        lsSet(storeKey, lsGet(storeKey, []).filter((s) => !(s.hex === hex && s.a === a)));
        renderPalette();
      };
    }
    box.append(i);
  }
}

function renderPalette() {
  const box = $('palette');
  box.innerHTML = '';
  paletteGroup(box, 'salvas', lsGet('dmi.saved', []), 'dmi.saved');
  paletteGroup(box, 'recentes', lsGet('dmi.recent', []), 'dmi.recent');
  paletteGroup(box, 'arquivo', docColors, null);
}

function pushRecent() {
  if (color.a === 0) return;
  const entry = { hex: rgb2hex(color), a: color.a };
  const recent = lsGet('dmi.recent', []).filter((e) => !(e.hex === entry.hex && e.a === entry.a));
  recent.unshift(entry);
  recent.length = Math.min(recent.length, 14);
  lsSet('dmi.recent', recent);
  renderPalette();
}

// ---------------------------------------------------------------- refresh

function navTo(patch) {
  commitFloatIfAny();
  selRect = null;
  if (patch.s !== undefined && patch.s !== sel.s) gridSel.clear(); // trocou de state
  sel = { ...sel, ...patch };
  refreshAll();
}

function refreshAll() {
  if (doc) {
    sel.s = Math.min(sel.s, doc.states.length - 1);
    const st = curState();
    sel.f = Math.min(sel.f, st.frameCount - 1);
    sel.d = Math.min(sel.d, st.dirs - 1);
    // descarta chaves de multi-seleção que ficaram fora do formato atual
    gridSel = new Set([...gridSel].filter((k) => {
      const [f, d] = k.split(':').map(Number);
      return f < st.frameCount && d < st.dirs;
    }));
  } else {
    gridSel.clear();
  }
  renderEditor();
  renderStates();
  renderGrid();
  renderProps();
  renderPalette();
  updateUndoButtons();
  $('stPath').textContent = doc ? `${doc.path} · ${doc.states.length} state(s)` : '—';
}

// ---------------------------------------------------------------- arquivos

async function loadDir(dir) {
  const r = await apiJson(`/api/list?dir=${encodeURIComponent(dir)}`);
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
    const p = (cwd === '.' ? '' : cwd + '/') + e.name;
    li.innerHTML = `<span class="ico">${e.type === 'dir' ? '📁' : '🖼'}</span> ${e.name}`;
    li.dataset.path = p;
    if (doc && doc.path === p) li.className = 'sel';
    li.onclick = () => (e.type === 'dir' ? loadDir(p) : openDmi(p));
    if (e.type === 'dmi') {
      li.addEventListener('mouseenter', () => (hoveredFile = p));
      li.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        showCtxMenu(ev.clientX, ev.clientY, p);
      });
    }
    ul.append(li);
  }
}

// ---- operacoes de arquivo (renomear / duplicar / excluir) ----

function showCtxMenu(x, y, path) {
  ctxTarget = path;
  const m = $('ctxMenu');
  m.hidden = false;
  m.style.left = Math.min(x, innerWidth - 180) + 'px';
  m.style.top = Math.min(y, innerHeight - 110) + 'px';
}
document.addEventListener('click', () => ($('ctxMenu').hidden = true));

const postJson = (url, body) =>
  apiJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function fileRename(p) {
  const base = p.split('/').pop();
  const nn = prompt('Novo nome do arquivo:', base);
  if (!nn || nn === base) return;
  const to = (p.includes('/') ? p.split('/').slice(0, -1).join('/') + '/' : '') + (nn.toLowerCase().endsWith('.dmi') ? nn : nn + '.dmi');
  try {
    await postJson('/api/file/rename', { from: p, to });
    for (const t of tabs) if (t.doc.path === p) t.doc.path = to; // doc ativo é o mesmo objeto
    if (doc?.path === to) history.replaceState(null, '', '#' + encodeURIComponent(to));
    renderTabs();
    refreshAll();
    loadDir(cwd);
    toast(`Renomeado para ${to}`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function fileDuplicate(p) {
  try {
    const r = await postJson('/api/file/duplicate', { path: p, toDir: cwd });
    loadDir(cwd);
    toast(`Duplicado: ${r.path}`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function fileDelete(p) {
  if (!confirm(`Excluir "${p}" do disco?\n\nEssa ação não cria backup.`)) return;
  try {
    await postJson('/api/file/delete', { path: p });
    const ti = tabs.findIndex((t) => t.doc.path === p);
    if (ti >= 0) {
      tabs[ti].dirty = false; // sem prompt de "não salvo": o arquivo já era
      closeTab(ti);
    }
    if (hoveredFile === p) hoveredFile = null;
    if (fileClip === p) fileClip = null;
    loadDir(cwd);
    toast('Arquivo excluído');
  } catch (err) {
    toast(err.message, true);
  }
}

$('ctxMenu').addEventListener('click', (e) => {
  const act = e.target.dataset?.act;
  if (!act || !ctxTarget) return;
  if (act === 'rename') fileRename(ctxTarget);
  else if (act === 'dup') fileDuplicate(ctxTarget);
  else if (act === 'del') fileDelete(ctxTarget);
});

const filesPanel = document.querySelector('.panel.files');
filesPanel.addEventListener('mouseenter', () => (filesHover = true));
filesPanel.addEventListener('mouseleave', () => {
  filesHover = false;
  hoveredFile = null;
});

function refreshFileSel() {
  for (const li of $('fileList').children) {
    li.classList.toggle('sel', !!doc && li.dataset.path === doc.path);
  }
}

function docFromEnvelope(header, body) {
  const d = {
    path: header.path, name: header.name,
    width: header.width, height: header.height, mtimeMs: header.mtimeMs,
    states: header.states,
  };
  const fsz = d.width * d.height * 4;
  let offB = 0;
  for (const st of d.states) {
    st.frames = [];
    for (let i = 0; i < st.frameCount * st.dirs; i++) {
      st.frames.push(body.subarray(offB, offB + fsz));
      offB += fsz;
    }
  }
  return d;
}

async function openDmi(path) {
  const existing = tabs.findIndex((t) => t.doc.path === path);
  if (existing >= 0) return activateTab(existing);
  try {
    const r = await fetch(`/api/open?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error((await r.json()).error);
    const { header, body } = await decodeEnvelope(r);
    newTab(docFromEnvelope(header, body));
    refreshAll();
    refreshFileSel();
  } catch (err) {
    toast(err.message, true);
  }
}

async function reloadActiveTab() {
  const r = await fetch(`/api/open?path=${encodeURIComponent(doc.path)}`);
  if (!r.ok) return;
  const { header, body } = await decodeEnvelope(r);
  doc = docFromEnvelope(header, body);
  tabs[tabIdx].doc = doc;
  undoStack = []; redoStack = []; undoBytes = redoBytes = 0;
  selRect = floating = floatSnap = null;
  docColors = collectDocColors(doc);
  setDirty(false);
  extChanged = false;
  refreshAll();
}

async function save(path = doc?.path, force = false) {
  if (!doc) return;
  commitFloatIfAny();
  try {
    const header = {
      path,
      width: doc.width,
      height: doc.height,
      expectedMtime: path === doc.path ? doc.mtimeMs : null,
      force,
      states: doc.states.map((s) => ({
        name: s.name, dirs: s.dirs, frameCount: s.frameCount,
        delays: s.delays, loop: s.loop, rewind: s.rewind,
        movement: s.movement, hotspots: s.hotspots,
      })),
    };
    const blob = encodeEnvelope(header, doc.states.flatMap((s) => s.frames));
    const r = await fetch('/api/save', { method: 'POST', body: blob });
    const body = await r.json();
    if (r.status === 409) {
      if (confirm('O arquivo mudou no disco desde que foi aberto (um .bak será criado). Sobrescrever?')) {
        return save(path, true);
      }
      return;
    }
    if (!r.ok) throw new Error(body.error);
    doc.path = path;
    doc.mtimeMs = body.mtimeMs;
    extChanged = false;
    setDirty(false);
    history.replaceState(null, '', '#' + encodeURIComponent(path));
    refreshAll();
    loadDir(cwd);
    toast(`Salvo: ${path} (${body.frames} frames, sheet ${body.sheet})`);
  } catch (err) {
    toast(err.message, true);
  }
}

function fitZoom() {
  if (!doc) return;
  const wrap = $('canvasWrap');
  const avail = Math.min(wrap.clientWidth - 60, wrap.clientHeight - 60);
  zoom = Math.max(1, Math.min(32, Math.floor(avail / Math.max(doc.width, doc.height))));
}

// deteccao de mudanca externa (Dream Maker regravou o arquivo, etc.)
setInterval(async () => {
  if (!doc?.path || doc.mtimeMs == null) return;
  try {
    const r = await apiJson(`/api/stat?path=${encodeURIComponent(doc.path)}`);
    if (r.mtimeMs == null || Math.abs(r.mtimeMs - doc.mtimeMs) < 0.001) return;
    if (!dirty) {
      await reloadActiveTab();
      toast('O arquivo mudou no disco — recarregado.');
    } else if (!extChanged) {
      extChanged = true;
      toast('⚠ O arquivo mudou no disco. Ao salvar, será pedida confirmação.', true);
    }
  } catch {}
}, 5000);

// ---------------------------------------------------------------- desenho

function pointerPixel(e) {
  const r = $('editor').getBoundingClientRect();
  return {
    x: Math.floor((e.clientX - r.left) / zoom),
    y: Math.floor((e.clientY - r.top) / zoom),
  };
}

const clampP = (p) => ({
  x: Math.max(0, Math.min(doc.width - 1, p.x)),
  y: Math.max(0, Math.min(doc.height - 1, p.y)),
});
const inBounds = (p) => p.x >= 0 && p.y >= 0 && p.x < doc.width && p.y < doc.height;
const inRect = (p, r) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;

function strokeColor(e) {
  return e.button === 2 || e.shiftKey ? { r: 0, g: 0, b: 0, a: 0 } : color;
}

// desenha considerando o modo espelho
function symLine(px, x0, y0, x1, y1, c, size = 1) {
  P.drawLine(px, doc.width, doc.height, x0, y0, x1, y1, c, size);
  if (symOn()) P.drawLine(px, doc.width, doc.height, mirrorX(x0), y0, mirrorX(x1), y1, c, size);
}
function symRect(px, x0, y0, x1, y1, c, filled) {
  P.drawRect(px, doc.width, doc.height, x0, y0, x1, y1, c, filled);
  if (symOn()) P.drawRect(px, doc.width, doc.height, mirrorX(x0), y0, mirrorX(x1), y1, c, filled);
}
function symFill(px, x, y, c) {
  P.floodFill(px, doc.width, doc.height, x, y, c);
  if (symOn()) P.floodFill(px, doc.width, doc.height, mirrorX(x), y, c);
}

$('editor').addEventListener('contextmenu', (e) => e.preventDefault());

$('editor').addEventListener('pointerdown', (e) => {
  if (!doc) return;
  const raw = pointerPixel(e);
  try { $('editor').setPointerCapture(e.pointerId); } catch {}

  if (tool === 'select') {
    const p = clampP(raw);
    if (floating) {
      if (inRect(p, { x: floating.x, y: floating.y, w: floating.w, h: floating.h })) {
        dragSel = { mode: 'float', dx: p.x - floating.x, dy: p.y - floating.y, moved: false };
        return;
      }
      commitFloatIfAny();
    }
    if (selRect && inRect(p, selRect)) {
      liftSelection(e.altKey);
      dragSel = { mode: 'float', dx: p.x - floating.x, dy: p.y - floating.y, moved: true };
      renderEditor();
      return;
    }
    dragSel = { mode: 'rect', ax: p.x, ay: p.y, moved: false };
    selRect = { x: p.x, y: p.y, w: 1, h: 1 };
    renderEditor();
    return;
  }

  if (!inBounds(raw)) return;
  const p = raw;
  commitFloatIfAny();

  const st = curState();
  const i = fidx(st, sel.f, sel.d);
  const px = st.frames[i];

  if (tool === 'picker' || e.altKey) {
    const c = P.getPx(px, doc.width, p.x, p.y);
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
    symFill(px, p.x, p.y, c);
    pushUndo({ kind: 'frame', s: sel.s, i, px: before });
    if (c.a > 0) pushRecent();
    lightRefresh();
    return;
  }

  stroke = { before, i, s: sel.s, start: p, last: p, c, buf: null };
  if (tool === 'pencil' || tool === 'eraser') symLine(px, p.x, p.y, p.x, p.y, c, brush());
  renderEditor();
});

$('editor').addEventListener('pointermove', (e) => {
  if (!doc) return;
  const p = pointerPixel(e);
  $('stPixel').textContent = inBounds(p) ? `x ${p.x}  y ${p.y}` : '';

  if (dragSel) {
    const cp = clampP(p);
    if (dragSel.mode === 'rect') {
      selRect = {
        x: Math.min(dragSel.ax, cp.x),
        y: Math.min(dragSel.ay, cp.y),
        w: Math.abs(cp.x - dragSel.ax) + 1,
        h: Math.abs(cp.y - dragSel.ay) + 1,
      };
      if (cp.x !== dragSel.ax || cp.y !== dragSel.ay) dragSel.moved = true;
    } else {
      floating.x = cp.x - dragSel.dx;
      floating.y = cp.y - dragSel.dy;
      selRect = { x: floating.x, y: floating.y, w: floating.w, h: floating.h };
      dragSel.moved = true;
    }
    renderEditor();
    return;
  }

  if (!stroke) return;
  const px = curState().frames[stroke.i];

  if (tool === 'pencil' || tool === 'eraser') {
    symLine(px, stroke.last.x, stroke.last.y, p.x, p.y, stroke.c, brush());
    stroke.last = p;
    renderEditor();
  } else if (tool === 'line' || tool === 'rect') {
    const buf = stroke.before.slice();
    if (tool === 'line') symLine(buf, stroke.start.x, stroke.start.y, p.x, p.y, stroke.c, brush());
    else symRect(buf, stroke.start.x, stroke.start.y, p.x, p.y, stroke.c, $('fillShape').checked);
    stroke.buf = buf;
    renderEditor(buf);
  }
});

$('editor').addEventListener('pointerup', () => {
  if (dragSel) {
    if (dragSel.mode === 'rect' && !dragSel.moved) selRect = null; // clique simples deseleciona
    dragSel = null;
    renderEditor();
    return;
  }
  if (!stroke) return;
  const px = curState().frames[stroke.i];
  if (stroke.buf) px.set(stroke.buf);
  pushUndo({ kind: 'frame', s: stroke.s, i: stroke.i, px: stroke.before });
  if (stroke.c.a > 0 && tool !== 'eraser') pushRecent();
  stroke = null;
  lightRefresh();
});

// ---------------------------------------------------------------- ferramentas / toolbar

function selectTool(t) {
  if (t !== 'select') commitFloatIfAny();
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
$('onionChk').onchange = () => renderEditor();
$('symChk').onchange = () => renderEditor();

$('btnSaveColor').onclick = () => {
  const entry = { hex: rgb2hex(color), a: color.a };
  const saved = lsGet('dmi.saved', []).filter((e) => !(e.hex === entry.hex && e.a === entry.a));
  saved.unshift(entry);
  lsSet('dmi.saved', saved);
  renderPalette();
  toast(`${entry.hex} salva na paleta (botão direito remove)`);
};

$('btnClear').onclick = () => doc && deleteSelection();
$('btnFlipH').onclick = () => flipFrame(true);
$('btnFlipV').onclick = () => flipFrame(false);

function flipFrame(horizontal) {
  if (!doc) return;
  commitFloatIfAny();
  if (gridSel.size && !selRect) {
    const targets = targetFrames();
    structural(() => {
      const st = curState();
      for (const i of targets) {
        st.frames[i] = horizontal
          ? P.flipH(st.frames[i], doc.width, doc.height)
          : P.flipV(st.frames[i], doc.width, doc.height);
      }
    });
    return;
  }
  const r = selRect;
  editFrame((px, before) => {
    if (r) {
      const reg = P.copyRegion(before, doc.width, doc.height, r.x, r.y, r.w, r.h);
      const fl = horizontal ? P.flipH(reg, r.w, r.h) : P.flipV(reg, r.w, r.h);
      for (let y = 0; y < r.h; y++) {
        px.set(fl.subarray(y * r.w * 4, (y + 1) * r.w * 4), P.idx(doc.width, r.x, r.y + y));
      }
    } else {
      px.set(horizontal ? P.flipH(before, doc.width, doc.height) : P.flipV(before, doc.width, doc.height));
    }
  });
}

$('btnCopy').onclick = () => copySel(false);
$('btnPaste').onclick = () => pasteRegion();

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

// ---------------------------------------------------------------- states

$('stateSearch').oninput = () => renderStates();

$('btnStateAdd').onclick = () =>
  doc &&
  structural(() => {
    doc.states.push({
      name: 'novo', dirs: 1, frameCount: 1, delays: [1],
      loop: 0, rewind: false, movement: false, hotspots: [], frames: [blank()],
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

// copiar/colar state (funciona entre abas; redimensiona se o icon size for outro)
$('btnStateCopy').onclick = () => {
  if (!doc) return;
  const st = curState();
  stateClipboard = {
    width: doc.width,
    height: doc.height,
    state: { ...st, delays: [...st.delays], hotspots: [...st.hotspots], frames: st.frames.map((f) => f.slice()) },
  };
  toast(`State "${st.name || '(sem nome)'}" copiado — cole em qualquer aba`);
};

$('btnStatePaste').onclick = () => {
  if (!doc || !stateClipboard) return toast('Nenhum state copiado', true);
  const src = stateClipboard;
  structural(() => {
    const frames =
      src.width === doc.width && src.height === doc.height
        ? src.state.frames.map((f) => f.slice())
        : src.state.frames.map((f) => P.scaleNearest(f, src.width, src.height, doc.width, doc.height));
    doc.states.splice(sel.s + 1, 0, { ...src.state, delays: [...src.state.delays], hotspots: [...src.state.hotspots], frames });
    sel = { s: sel.s + 1, f: 0, d: 0 };
  });
  if (src.width !== doc.width || src.height !== doc.height) {
    toast(`State colado (redimensionado de ${src.width}×${src.height})`);
  }
};

// duplicatas
$('btnDups').onclick = () => {
  if (!doc) return;
  const groups = new Map();
  doc.states.forEach((st, i) => {
    const key = `${st.dirs}|${st.frameCount}|${st.frames.map(P.hashFrame).join(',')}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(i);
  });

  const items = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const ref = doc.states[idxs[0]];
    const real = idxs.filter(
      (i) => i === idxs[0] || doc.states[i].frames.every((f, k) => P.framesEqual(f, ref.frames[k]))
    );
    if (real.length > 1) {
      items.push({
        label: 'States idênticos: ' + real.map((i) => `#${i + 1} "${doc.states[i].name || '(sem nome)'}"`).join(' ≡ '),
        go: { s: real[0], f: 0, d: 0 },
      });
    }
  }

  doc.states.forEach((st, i) => {
    if (st.frameCount < 2) return;
    const fh = [];
    for (let f = 0; f < st.frameCount; f++) {
      let hh = '';
      for (let d = 0; d < st.dirs; d++) hh += P.hashFrame(st.frames[fidx(st, f, d)]) + ',';
      fh.push(hh);
    }
    const dupFrames = [];
    for (let a = 0; a < fh.length; a++) {
      for (let b = a + 1; b < fh.length; b++) {
        if (fh[a] === fh[b]) dupFrames.push(`${a + 1}≡${b + 1}`);
      }
    }
    if (dupFrames.length) {
      items.push({
        label: `State #${i + 1} "${st.name || '(sem nome)'}": frames repetidos ${dupFrames.join(', ')}`,
        go: { s: i, f: 0, d: 0 },
      });
    }
  });

  if (!items.length) return toast('Nenhuma duplicata encontrada 👍');
  const ul = $('dupList');
  ul.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.textContent = it.label;
    li.onclick = () => {
      $('dlgDups').close();
      navTo(it.go);
    };
    ul.append(li);
  }
  $('dlgDups').showModal();
};

// ---------------------------------------------------------------- frames

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

// ---------------------------------------------------------------- propriedades

let nameSnap = null;
$('pName').onfocus = () => (nameSnap = curState()?.name ?? null);
$('pName').oninput = (e) => {
  if (!doc) return;
  curState().name = e.target.value;
  const li = $('stateList').querySelector(`li[data-s="${sel.s}"] .nm`);
  if (li) {
    li.textContent = e.target.value || '(sem nome)';
    li.classList.toggle('anon', !e.target.value);
  }
  setDirty();
};
$('pName').onchange = (e) => {
  if (nameSnap !== null && nameSnap !== e.target.value) {
    pushUndo({ kind: 'meta', s: sel.s, props: { name: nameSnap } });
  }
  nameSnap = null;
};

$('pDirs').onchange = (e) => doc && structural(() => resizeFrames(curState(), curState().frameCount, +e.target.value));
$('pFrames').onchange = (e) => {
  if (!doc) return;
  const n = Math.max(1, Math.min(512, +e.target.value));
  structural(() => resizeFrames(curState(), n, curState().dirs));
};
$('pDelay').onchange = (e) => {
  if (!doc) return;
  const delays = [...curState().delays];
  delays[sel.f] = Math.max(0, +e.target.value);
  metaEdit({ delays });
};
$('pLoop').onchange = (e) => doc && metaEdit({ loop: Math.max(0, +e.target.value) });
$('pRewind').onchange = (e) => doc && metaEdit({ rewind: e.target.checked });
$('pMovement').onchange = (e) => doc && metaEdit({ movement: e.target.checked });

// gerar direções: copia (com espelho opcional) uma dir pra outra em todos os frames
$('btnDirCopy').onclick = () => {
  if (!doc) return;
  const from = +$('dcFrom').value;
  const to = +$('dcTo').value;
  if (from === to) return toast('Origem e destino iguais', true);
  const flip = $('dcFlip').checked;
  structural(() => {
    const st = curState();
    for (let f = 0; f < st.frameCount; f++) {
      let buf = st.frames[fidx(st, f, from)].slice();
      if (flip) buf = P.flipH(buf, doc.width, doc.height);
      st.frames[fidx(st, f, to)] = buf;
    }
  });
  toast(`${DIR_NAMES[from]} → ${DIR_NAMES[to]}${flip ? ' (espelhado)' : ''} em todos os frames`);
};

// ---------------------------------------------------------------- dialogos: novo / redimensionar

$('btnNew').onclick = () => $('dlgNew').showModal();

$('dlgNew').addEventListener('close', () => {
  if ($('dlgNew').returnValue !== 'ok') return;
  const name = $('nName').value.trim().replace(/\.dmi$/i, '') || 'novo';
  const w = Math.max(1, Math.min(512, +$('nW').value));
  const h = Math.max(1, Math.min(512, +$('nH').value));
  const d = {
    path: (cwd === '.' ? '' : cwd + '/') + name + '.dmi',
    name, width: w, height: h, mtimeMs: null,
    states: [{ name: '', dirs: 1, frameCount: 1, delays: [1], loop: 0, rewind: false, movement: false, hotspots: [], frames: [new Uint8ClampedArray(w * h * 4)] }],
  };
  newTab(d);
  setDirty(true);
  refreshAll();
});

$('btnSave').onclick = () => save();
$('btnSaveAs').onclick = () => {
  if (!doc) return;
  const name = prompt('Salvar como (caminho relativo à raiz):', doc.path);
  if (name) save(name.endsWith('.dmi') ? name : name + '.dmi');
};

$('btnResize').onclick = () => {
  if (!doc) return;
  $('rW').value = doc.width;
  $('rH').value = doc.height;
  $('dlgResize').showModal();
};

$('dlgResize').addEventListener('close', () => {
  if ($('dlgResize').returnValue !== 'ok' || !doc) return;
  const W = Math.max(1, Math.min(512, +$('rW').value));
  const H = Math.max(1, Math.min(512, +$('rH').value));
  if (W === doc.width && H === doc.height) return;
  const mode = document.querySelector('input[name="rmode"]:checked').value;
  const [ax, ay] = $('rAnchor').value.split(',').map(Number);
  const ow = doc.width, oh = doc.height;
  structural(() => {
    for (const st of doc.states) {
      st.frames = st.frames.map((f) =>
        mode === 'scale'
          ? P.scaleNearest(f, ow, oh, W, H)
          : P.placed(f, ow, oh, W, H, Math.round((W - ow) * ax), Math.round((H - oh) * ay))
      );
    }
    doc.width = W;
    doc.height = H;
  });
  fitZoom();
  refreshAll();
  toast(`DMI agora é ${W}×${H}`);
});

// ---------------------------------------------------------------- dialogos: matiz / substituir cor

const hueParams = () => ({ dh: +$('hH').value, ds: +$('hS').value, dl: +$('hL').value });

// mostra/esconde a opção "frames selecionados" conforme a multi-seleção da grade
function syncScopeOption(wrapId, lblId, radioName) {
  const has = gridSel.size > 0;
  $(wrapId).hidden = !has;
  $(lblId).textContent = `frames selecionados (${gridSel.size})`;
  const radio = document.querySelector(`input[name="${radioName}"][value="selframes"]`);
  if (has) radio.checked = true;
  else if (radio.checked) document.querySelector(`input[name="${radioName}"][value="frame"]`).checked = true;
}

$('btnHue').onclick = () => {
  if (!doc) return;
  commitFloatIfAny();
  hueBase = curFrame().slice();
  for (const [id, lbl] of [['hH', 'hHv'], ['hS', 'hSv'], ['hL', 'hLv']]) {
    $(id).value = 0;
    $(lbl).textContent = '0';
  }
  syncScopeOption('hSelWrap', 'hSelLbl', 'hscope');
  $('dlgHue').showModal();
};

for (const [id, lbl] of [['hH', 'hHv'], ['hS', 'hSv'], ['hL', 'hLv']]) {
  $(id).oninput = () => {
    $(lbl).textContent = $(id).value;
    if (hueBase) renderEditor(P.hslAdjust(hueBase, hueParams()));
  };
}

$('dlgHue').addEventListener('close', () => {
  const params = hueParams();
  const base = hueBase;
  hueBase = null;
  if ($('dlgHue').returnValue !== 'ok' || !doc || !base) return renderEditor();
  if (params.dh === 0 && params.ds === 0 && params.dl === 0) return renderEditor();

  const scope = document.querySelector('input[name="hscope"]:checked').value;
  if (scope === 'frame') {
    editFrame((px) => px.set(P.hslAdjust(base, params)));
  } else if (scope === 'selframes') {
    const targets = targetFrames();
    structural(() => {
      const st = curState();
      for (const i of targets) st.frames[i] = P.hslAdjust(st.frames[i], params);
    });
  } else {
    structural(() => {
      const targets = scope === 'state' ? [curState()] : doc.states;
      for (const st of targets) st.frames = st.frames.map((f) => P.hslAdjust(f, params));
    });
  }
  docColors = collectDocColors(doc);
  renderPalette();
  const scopeLabel = { frame: 'frame', selframes: `${gridSel.size || 1} frames`, state: 'state inteiro', dmi: 'DMI inteiro' };
  toast(`Matiz aplicado (${scopeLabel[scope]})`);
});

$('btnReplace').onclick = () => {
  if (!doc) return;
  $('repFrom').value = rgb2hex(color);
  syncScopeOption('rSelWrap', 'rSelLbl', 'rscope');
  $('dlgReplace').showModal();
};
$('btnRepUseCur').onclick = (e) => {
  e.preventDefault();
  $('repFrom').value = rgb2hex(color);
};

$('dlgReplace').addEventListener('close', () => {
  if ($('dlgReplace').returnValue !== 'ok' || !doc) return;
  const from = hex2rgb($('repFrom').value);
  const to = hex2rgb($('repTo').value);
  const scope = document.querySelector('input[name="rscope"]:checked').value;
  let n = 0;
  if (scope === 'frame') {
    editFrame((px) => (n = P.replaceColor(px, from, to)));
  } else if (scope === 'selframes') {
    const targets = targetFrames();
    structural(() => {
      const st = curState();
      for (const i of targets) n += P.replaceColor(st.frames[i], from, to);
    });
  } else {
    structural(() => {
      const targets = scope === 'state' ? [curState()] : doc.states;
      for (const st of targets) for (const f of st.frames) n += P.replaceColor(f, from, to);
    });
  }
  docColors = collectDocColors(doc);
  renderPalette();
  toast(n ? `${n} pixels trocados` : 'Nenhum pixel com essa cor exata', !n);
});

// ---------------------------------------------------------------- import PNG

$('btnImport').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  if (e.target.files[0]) importPngFile(e.target.files[0]);
  e.target.value = '';
};

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files?.[0];
  if (!f) return;
  if (f.name.toLowerCase().endsWith('.png')) importPngFile(f);
  else if (f.name.toLowerCase().endsWith('.dmi')) toast('Para abrir um .dmi use a lista de Arquivos (o navegador não informa o caminho).', true);
});

async function importPngFile(file) {
  if (!doc) return toast('Abra ou crie um DMI antes de importar', true);
  try {
    const r = await fetch('/api/import/png', { method: 'POST', body: await file.arrayBuffer() });
    if (!r.ok) throw new Error((await r.json()).error);
    const { header, body } = await decodeEnvelope(r);
    pendingImport = { rgba: body, w: header.width, h: header.height, name: file.name.replace(/\.png$/i, '') };

    const aligned = pendingImport.w % doc.width === 0 && pendingImport.h % doc.height === 0;
    const cols = pendingImport.w / doc.width;
    const rows = pendingImport.h / doc.height;
    $('impInfo').textContent = `${file.name} — ${pendingImport.w}×${pendingImport.h}` +
      (aligned ? ` = grade de ${cols}×${rows} células de ${doc.width}×${doc.height}` : ` (não é múltiplo de ${doc.width}×${doc.height})`);

    $('impAligned').hidden = !aligned;
    $('impMis').hidden = aligned;
    if (aligned) {
      const total = cols * rows;
      const sDirs = $('impDirs');
      sDirs.innerHTML = '';
      for (const d of [1, 4, 8]) if (total % d === 0) sDirs.add(new Option(`${d} (${total / d} frames)`, d));
      sDirs.onchange = () => ($('impFramesLbl').textContent = `${total / +sDirs.value} frames`);
      sDirs.onchange();
    }
    $('dlgImport').showModal();
  } catch (err) {
    toast(err.message, true);
  }
}

$('dlgImport').addEventListener('close', () => {
  if ($('dlgImport').returnValue !== 'ok' || !doc || !pendingImport) return (pendingImport = null);
  const imp = pendingImport;
  pendingImport = null;
  const aligned = imp.w % doc.width === 0 && imp.h % doc.height === 0;

  structural(() => {
    let frames = [];
    let dirs = 1;
    if (aligned) {
      const cols = imp.w / doc.width;
      const rows = imp.h / doc.height;
      const total = cols * rows;
      dirs = +$('impDirs').value;
      for (let k = 0; k < total; k++) {
        frames.push(P.copyRegion(imp.rgba, imp.w, imp.h, (k % cols) * doc.width, Math.floor(k / cols) * doc.height, doc.width, doc.height));
      }
    } else {
      const mode = document.querySelector('input[name="imode"]:checked').value;
      frames = [
        mode === 'scale' ? P.scaleNearest(imp.rgba, imp.w, imp.h, doc.width, doc.height)
        : mode === 'center' ? P.placed(imp.rgba, imp.w, imp.h, doc.width, doc.height, Math.round((doc.width - imp.w) / 2), Math.round((doc.height - imp.h) / 2))
        : P.placed(imp.rgba, imp.w, imp.h, doc.width, doc.height, 0, 0),
      ];
    }
    const frameCount = frames.length / dirs;
    doc.states.push({
      name: imp.name, dirs, frameCount,
      delays: frameCount > 1 ? new Array(frameCount).fill(1) : [],
      loop: 0, rewind: false, movement: false, hotspots: [], frames,
    });
    sel = { s: doc.states.length - 1, f: 0, d: 0 };
  });
  docColors = collectDocColors(doc);
  renderPalette();
  toast(`Importado como state "${imp.name}"`);
});

// ---------------------------------------------------------------- export

async function download(url, blob, filename) {
  const r = await fetch(url, { method: 'POST', body: blob });
  if (!r.ok) throw new Error((await r.json()).error);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob());
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const exportBase = () => `${doc.name}_${(curState().name || 'state').replace(/[^\w-]+/g, '_')}`;

$('btnExpGif').onclick = async () => {
  if (!doc) return;
  commitFloatIfAny();
  try {
    const st = curState();
    const seq = [...Array(st.frameCount).keys()];
    if (st.rewind && st.frameCount > 2) seq.push(...seq.slice(1, -1).reverse());
    const frames = seq.map((f) => st.frames[fidx(st, f, sel.d)]);
    const delays = seq.map((f) => Math.max(2, Math.round((st.delays[f] ?? 1) * 10)));
    const blob = encodeEnvelope(
      { width: doc.width, height: doc.height, delays, loop: st.loop, count: frames.length },
      frames
    );
    await download('/api/export/gif', blob, `${exportBase()}_${DIR_NAMES[sel.d]}.gif`);
  } catch (err) {
    toast(err.message, true);
  }
};

// folha: dialogo com escolha de states + preview antes de baixar
$('btnExpSheet').onclick = () => {
  if (!doc) return;
  commitFloatIfAny();
  const box = $('sheetStates');
  box.innerHTML = '';
  doc.states.forEach((st, i) => {
    const lbl = document.createElement('label');
    lbl.className = 'chk';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.value = i;
    chk.checked = i === sel.s;
    chk.onchange = updateSheetPreview;
    lbl.append(chk, ` ${i + 1}. ${st.name || '(sem nome)'} — ${st.dirs}d ${st.frameCount}f`);
    box.append(lbl);
  });
  updateSheetPreview();
  $('dlgSheet').showModal();
};

const sheetChecks = () => [...$('sheetStates').querySelectorAll('input:checked')].map((el) => +el.value);

$('btnSheetAll').onclick = (e) => {
  e.preventDefault();
  const inputs = [...$('sheetStates').querySelectorAll('input')];
  const all = inputs.every((i) => i.checked);
  inputs.forEach((i) => (i.checked = !all));
  updateSheetPreview();
};

// uma linha por state; células = frames na ordem de armazenamento (frame × direção)
function sheetLayout() {
  const frames = [];
  const positions = [];
  let row = 0;
  for (const si of sheetChecks()) {
    doc.states[si].frames.forEach((f, k) => {
      frames.push(f);
      positions.push({ x: k, y: row });
    });
    row++;
  }
  return { frames, positions };
}

function updateSheetPreview() {
  const { frames, positions } = sheetLayout();
  const cv = $('sheetPreview');
  if (!frames.length) {
    cv.width = cv.height = 0;
    $('sheetInfo').textContent = 'nenhum state selecionado';
    return;
  }
  cv.width = (Math.max(...positions.map((p) => p.x)) + 1) * doc.width;
  cv.height = (Math.max(...positions.map((p) => p.y)) + 1) * doc.height;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  frames.forEach((f, i) =>
    ctx.putImageData(new ImageData(f.slice(), doc.width, doc.height), positions[i].x * doc.width, positions[i].y * doc.height)
  );
  $('sheetInfo').textContent = `${cv.width}×${cv.height}px — ${frames.length} frames (linha = state, célula = frame×direção)`;
}

$('dlgSheet').addEventListener('close', async () => {
  if ($('dlgSheet').returnValue !== 'ok' || !doc) return;
  try {
    const { frames, positions } = sheetLayout();
    if (!frames.length) return toast('Nenhum state selecionado', true);
    const blob = encodeEnvelope(
      { width: doc.width, height: doc.height, count: frames.length, positions },
      frames
    );
    await download('/api/export/png', blob, `${doc.name}_sheet.png`);
  } catch (err) {
    toast(err.message, true);
  }
});

$('btnExpFrame').onclick = async () => {
  if (!doc) return;
  commitFloatIfAny();
  try {
    const blob = encodeEnvelope({ width: doc.width, height: doc.height, cols: 1, count: 1 }, [curFrame()]);
    await download('/api/export/png', blob, `${exportBase()}_f${sel.f + 1}${DIR_NAMES[sel.d]}.png`);
  } catch (err) {
    toast(err.message, true);
  }
};

// ---------------------------------------------------------------- preview / scrub

$('btnPlay').onclick = () => {
  playing = !playing;
  $('btnPlay').innerHTML = playing ? '&#10073;&#10073;' : '&#9654;';
};

$('scrub').oninput = (e) => {
  if (!doc) return;
  playing = false;
  $('btnPlay').innerHTML = '&#9654;';
  commitFloatIfAny();
  selRect = null;
  sel.f = +e.target.value;
  renderEditor();
  renderGrid();
  renderProps();
};

function previewLoop() {
  requestAnimationFrame(previewLoop);
  if (!doc) {
    // nada aberto: não deixa o último sprite fantasma no preview
    const cv = $('preview');
    if (cv.width) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    return;
  }
  if (selRect || floating) renderEditor(); // anima o tracejado da seleção

  const st = curState();
  const cv = $('preview');
  if (cv.width !== doc.width || cv.height !== doc.height) {
    cv.width = doc.width;
    cv.height = doc.height;
  }

  let f = sel.f;
  if (playing && st.frameCount > 1) {
    // delays em décimos de segundo (1 = 0,1s), igual à BYOND
    const seq = [...Array(st.frameCount).keys()];
    if (st.rewind && st.frameCount > 2) seq.push(...seq.slice(1, -1).reverse());
    const total = seq.reduce((n, i) => n + Math.max(0.1, st.delays[i] ?? 1), 0);
    let t = (performance.now() / 100) % total;
    for (const i of seq) {
      t -= Math.max(0.1, st.delays[i] ?? 1);
      if (t <= 0) { f = i; break; }
    }
  }
  const px = st.frames[fidx(st, f, sel.d)];
  cv.getContext('2d').putImageData(new ImageData(px.slice(), doc.width, doc.height), 0, 0);
}
$('btnPlay').innerHTML = '&#10073;&#10073;';
requestAnimationFrame(previewLoop);

// ---------------------------------------------------------------- teclado

document.addEventListener('keydown', (e) => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (document.querySelector('dialog[open]')) return;

  // com o mouse sobre a lista de arquivos, as teclas agem no arquivo apontado
  if (filesHover && hoveredFile) {
    const k = e.key.toLowerCase();
    if (e.key === 'F2') { e.preventDefault(); return fileRename(hoveredFile); }
    if (e.key === 'Delete') { e.preventDefault(); return fileDelete(hoveredFile); }
    if ((e.ctrlKey || e.metaKey) && k === 'c') {
      e.preventDefault();
      fileClip = hoveredFile;
      return toast(`Copiado: ${fileClip} (Ctrl+V duplica)`);
    }
    if ((e.ctrlKey || e.metaKey) && k === 'v' && fileClip) {
      e.preventDefault();
      return fileDuplicate(fileClip);
    }
  }
  if (e.key === 'F2' && doc && doc.mtimeMs != null) {
    e.preventDefault();
    return fileRename(doc.path);
  }
  if (e.key === '[' || e.key === ']') {
    const b = $('brushSize');
    b.value = Math.max(1, Math.min(16, +b.value + (e.key === ']' ? 1 : -1)));
    return toast(`Espessura: ${b.value}px`);
  }

  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); save(); }
    else if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    else if (k === 'c') { e.preventDefault(); copySel(false); }
    else if (k === 'x') { e.preventDefault(); copySel(true); }
    else if (k === 'v') { e.preventDefault(); pasteRegion(); }
    else if (k === 'a' && doc) {
      e.preventDefault();
      commitFloatIfAny();
      selRect = { x: 0, y: 0, w: doc.width, h: doc.height };
      selectTool('select');
      renderEditor();
    }
    return;
  }

  const tools = { b: 'pencil', e: 'eraser', g: 'fill', i: 'picker', l: 'line', r: 'rect', m: 'select' };
  if (tools[e.key]) return selectTool(tools[e.key]);
  if (e.key === 'Delete') return deleteSelection();
  if (!doc) return;

  if (e.key === 'Escape') {
    cancelFloatSilent();
    selRect = null;
    renderEditor();
    return;
  }
  if (e.key === 'Enter') {
    commitFloatIfAny();
    selRect = null;
    renderEditor();
    return;
  }

  const arrows = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
  const dir = arrows[e.key];
  if (!dir) return;
  e.preventDefault();

  if (e.shiftKey) {
    // desloca o frame inteiro com wrap (ou todos os frames multi-selecionados)
    if (gridSel.size) {
      const targets = targetFrames();
      structural(() => {
        const st = curState();
        for (const i of targets) st.frames[i] = P.shiftWrap(st.frames[i], doc.width, doc.height, dir[0], dir[1]);
      });
    } else {
      editFrame((px, before) => px.set(P.shiftWrap(before, doc.width, doc.height, dir[0], dir[1])));
    }
    return;
  }
  if (nudge(dir[0], dir[1])) return; // move a seleção

  const st = curState();
  if (dir[0]) navTo({ f: (sel.f + dir[0] + st.frameCount) % st.frameCount });
  else navTo({ d: (sel.d + dir[1] + st.dirs) % st.dirs });
});

window.addEventListener('beforeunload', (e) => {
  snapshotTab();
  if (tabs.some((t) => t.dirty)) e.preventDefault();
});

// ---------------------------------------------------------------- boot

const initial = decodeURIComponent(location.hash.slice(1));
const startDir = initial.includes('/') ? initial.split('/').slice(0, -1).join('/') : '.';
await loadDir(startDir).catch(() => loadDir('.'));
if (initial) await openDmi(initial);
refreshAll();

// ?open=btnHue abre um diálogo direto (útil pra depurar/screenshotar a UI)
const dbgOpen = new URLSearchParams(location.search).get('open');
if (dbgOpen) setTimeout(() => $(dbgOpen)?.click(), 300);
