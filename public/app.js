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
let pendingImport = null; // { srcFrames, w, h, srcDelays, loop, animated, hasAlpha, name, type, viaCanvas }
let importResult = null;  // { all, kept, frames, bgColor, cleared, mode, colors, delays, tw, th, cols, rows }
let impSkip = new Set();  // índices (na lista convertida) das células/quadros que NÃO entram
let impSkipTotal = -1;    // total pro qual o impSkip foi montado: se mudar, a seleção não vale mais
let impBgManual = false;  // false = cor do fundo detectada na borda; true = a do #impBgColor
let impOpening = false;   // um import está sendo montado (decodificando): o diálogo vai abrir

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

// Um DMI pode não ter state NENHUM (é válido, e a BYOND aceita). Então curState() pode ser
// undefined em qualquer lugar — quem for usar tem que checar.
const curState = () => doc?.states[sel.s];
const fidx = (st, f, d) => f * st.dirs + d;
// nada de curState()?.frames[fidx(curState(), ...)]: o fidx é avaliado ANTES do ?. curto-circuitar
const curFrame = () => {
  const st = curState();
  return st ? st.frames[fidx(st, sel.f, sel.d)] : null;
};
const blank = () => new Uint8ClampedArray(doc.width * doc.height * 4);
const brush = () => Math.max(1, Math.min(16, +$('brushSize').value || 1));

// indices de frame alvo de efeitos: a multi-seleção da grade, ou só o frame atual
function targetFrames() {
  const st = curState();
  if (!st) return [];
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
    trim: cloneTrim(s.trim), // sem cópia funda o snapshot de undo compartilharia a lixeira viva
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
  if (!st) return; // DMI sem state: nada pra editar (cobre desenho, seleção, matiz, substituir cor)
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
  if (!doc || !curState()) return;
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
  if (!doc || !curState()) return;
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
  if (!doc || !clipboard || !curState()) return;
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

// Não deixa o último sprite fantasma no preview. Feito aqui (e não só no previewLoop) pra
// não depender de um requestAnimationFrame acontecer depois de fechar a aba.
function clearPreview() {
  const cv = $('preview');
  if (cv.width) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
}

function renderEditor(previewBuf) {
  const cv = $('editor');
  if (!doc) {
    cv.hidden = true;
    $('empty').hidden = false;
    $('noStates').hidden = true;
    $('stSize').textContent = '';
    clearPreview();
    return;
  }

  // doc aberto mas SEM state nenhum: não é o mesmo que "sem doc" (o icon size existe e pode
  // ser trocado à vontade justamente agora, que não há frame pra converter)
  const st = curState();
  if (!st) {
    cv.hidden = true;
    $('empty').hidden = true;
    $('noStates').hidden = false;
    $('stSize').textContent = `${doc.width}×${doc.height} · sem states`;
    $('stSel').textContent = '';
    clearPreview();
    return;
  }

  cv.hidden = false;
  $('empty').hidden = true;
  $('noStates').hidden = true;

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
  const st = curState();
  if (c && st) pixelsToCanvas(st.frames[fidx(st, f, d)], doc.width, doc.height, c);
}

function renderGrid() {
  const box = $('grid');
  box.innerHTML = '';
  const st = curState();
  if (!doc || !st) return; // sem state, a grade fica vazia

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
    $('pFramesTrim').textContent = '';
    $('scrub').value = 0;
    $('scrub').max = 0;
    $('scrub').disabled = true;
    $('scrubLabel').textContent = '—';
    return;
  }
  // sem esse aviso a lixeira seria invisível: o usuário continuaria achando que perdeu os frames
  const nTrim = trimCount(st);
  $('pFramesTrim').textContent = nTrim
    ? `${nTrim} frame(s) guardado(s) — volte pra ${st.frameCount + nTrim} pra recuperar (somem ao salvar)`
    : '';
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
    // piso 0: com 0 states, Math.min(sel.s, -1) daria -1 e tudo que lê curState() quebraria
    const n = doc.states.length;
    sel.s = n ? Math.min(Math.max(0, sel.s), n - 1) : 0;
    const st = curState();
    sel.f = st ? Math.min(sel.f, st.frameCount - 1) : 0;
    sel.d = st ? Math.min(sel.d, st.dirs - 1) : 0;
    // descarta chaves de multi-seleção que ficaram fora do formato atual
    gridSel = st
      ? new Set([...gridSel].filter((k) => {
          const [f, d] = k.split(':').map(Number);
          return f < st.frameCount && d < st.dirs;
        }))
      : new Set();
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
    doc.states.forEach(dropTrim); // salvou: o que foi descartado agora é definitivo
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
  if (!doc || !curState()) return;
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
  if (!doc || !curState()) return;
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
  if (!doc || !curState()) return;
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
    gridSel.clear(); // trocando de state: a multi-seleção do anterior não vale mais
    doc.states.push({
      name: 'novo', dirs: 1, frameCount: 1, delays: [1],
      loop: 0, rewind: false, movement: false, hotspots: [], frames: [blank()],
    });
    sel = { s: doc.states.length - 1, f: 0, d: 0 };
  });

$('btnStateDup').onclick = () =>
  doc && curState() &&
  structural(() => {
    gridSel.clear();
    const st = curState();
    doc.states.splice(sel.s + 1, 0, {
      ...st,
      delays: [...st.delays],
      hotspots: [...st.hotspots],
      frames: st.frames.map((f) => f.slice()),
      trim: null, // a cópia não herda a lixeira (o spread compartilharia o mesmo objeto)
    });
    sel.s++;
  });

// Dá pra apagar TODOS os states: um DMI sem state é válido, e é justamente com ele vazio que
// o tamanho do ícone pode ser trocado à vontade. Sem confirm() — structural() snapshota o doc
// inteiro, então Ctrl+Z traz o state de volta.
$('btnStateDel').onclick = () => {
  if (!doc || !curState()) return;
  gridSel.clear();
  structural(() => {
    doc.states.splice(sel.s, 1);
    sel = { s: Math.max(0, sel.s - 1), f: 0, d: 0 };
  });
  if (!doc.states.length) toast('DMI sem states — crie um (+), importe uma imagem, ou troque o tamanho do ícone à vontade.');
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
  if (!doc || !curState()) return;
  const st = curState();
  stateClipboard = {
    width: doc.width,
    height: doc.height,
    state: { ...st, trim: null, delays: [...st.delays], hotspots: [...st.hotspots], frames: st.frames.map((f) => f.slice()) },
  };
  toast(`State "${st.name || '(sem nome)'}" copiado — cole em qualquer aba`);
};

$('btnStatePaste').onclick = () => {
  if (!doc || !stateClipboard) return toast('Nenhum state copiado', true);
  const src = stateClipboard;
  structural(() => {
    gridSel.clear();
    const frames =
      src.width === doc.width && src.height === doc.height
        ? src.state.frames.map((f) => f.slice())
        : src.state.frames.map((f) => P.scaleNearest(f, src.width, src.height, doc.width, doc.height));
    doc.states.splice(sel.s + 1, 0, { ...src.state, trim: null, delays: [...src.state.delays], hotspots: [...src.state.hotspots], frames });
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

// Lixeira do state: diminuir Frames/Direções NÃO destrói pixel. O que sai fica guardado em
// st.trim (buffer por "frame:direção" + o delay do frame) e volta se o número voltar — um campo
// numérico não deveria ser destrutivo. O descarte só vira definitivo ao SALVAR.
//
// A lixeira é indexada por ÍNDICE de frame e vale só pro icon size atual, então tudo que
// desloca índices (splice de frame) ou troca o tamanho dos buffers (icon size, state vindo de
// outro DMI) precisa DESCARTÁ-LA — senão ela devolve o pixel errado, em silêncio.
const dropTrim = (st) => { if (st) st.trim = null; };

function cloneTrim(t) {
  if (!t) return null;
  const bufs = {};
  for (const [k, v] of Object.entries(t.bufs)) bufs[k] = v.slice();
  return { bufs, delays: { ...t.delays } };
}

// quantos frames dá pra recuperar aumentando o contador (só os que estão ALÉM do total atual)
function trimCount(st) {
  if (!st?.trim) return 0;
  const fs = new Set();
  for (const k of Object.keys(st.trim.bufs)) {
    const f = +k.split(':')[0];
    if (f >= st.frameCount) fs.add(f);
  }
  return fs.size;
}

function resizeFrames(st, frameCount, dirs) {
  const trim = st.trim ?? { bufs: {}, delays: {} };

  // guarda o que vai sumir (frame além do novo total, ou direção além do novo dirs)
  for (let f = 0; f < st.frameCount; f++) {
    for (let d = 0; d < st.dirs; d++) {
      if (f < frameCount && d < dirs) continue;
      trim.bufs[`${f}:${d}`] = st.frames[f * st.dirs + d];
    }
    if (f >= frameCount) trim.delays[f] = st.delays[f] ?? 1;
  }

  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    for (let d = 0; d < dirs; d++) {
      const old = f < st.frameCount && d < st.dirs ? st.frames[f * st.dirs + d] : null;
      // célula nova: a lixeira primeiro (é exatamente o que o usuário tirou); só depois a regra
      // antiga — direção nova (ex: 4 -> 8) começa como cópia da dir 0 (S), frame novo em branco
      const buf = old
        ?? trim.bufs[`${f}:${d}`]
        ?? (f < st.frameCount ? st.frames[f * st.dirs] : null);
      frames.push(buf ? buf.slice() : blank());
    }
  }
  const delays = [];
  for (let f = 0; f < frameCount; f++) {
    delays.push(st.delays[f] ?? trim.delays[f] ?? st.delays.at(-1) ?? 1);
  }
  st.frames = frames;
  st.frameCount = frameCount;
  st.dirs = dirs;
  st.delays = delays;
  st.trim = Object.keys(trim.bufs).length ? trim : null;
}

$('btnFrameAdd').onclick = () => doc && curState() && structural(() => {
  const st = curState();
  resizeFrames(st, st.frameCount + 1, st.dirs);
  sel.f = st.frameCount - 1;
});

$('btnFrameDup').onclick = () => doc && curState() && structural(() => {
  const st = curState();
  const copy = [];
  for (let d = 0; d < st.dirs; d++) copy.push(st.frames[fidx(st, sel.f, d)].slice());
  st.frames.splice((sel.f + 1) * st.dirs, 0, ...copy);
  st.delays.splice(sel.f + 1, 0, st.delays[sel.f] ?? 1);
  st.frameCount++;
  sel.f++;
  dropTrim(st); // o splice desloca os índices: a lixeira apontaria pro frame errado
});

$('btnFrameDel').onclick = () => {
  if (!doc || !curState()) return;
  const st = curState();
  if (st.frameCount < 2) return toast('O state precisa de pelo menos 1 frame', true);
  structural(() => {
    st.frames.splice(sel.f * st.dirs, st.dirs);
    st.delays.splice(sel.f, 1);
    st.frameCount--;
    sel.f = Math.max(0, sel.f - 1);
    dropTrim(st); // idem: excluir um frame do meio invalida os índices guardados
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

// O efeito roda no CLIQUE do OK, não no evento 'close' do <dialog>: 'close' é assíncrono
// (e, no smoke headless, chega tarde ou não chega). O clique é síncrono, e o form fecha o
// diálogo logo depois.
$('btnNewOk').onclick = () => {
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
};

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

// Troca o tamanho do ícone do DMI, convertendo os frames que já existem.
// Chamar SEMPRE de dentro de um structural() (não chama refreshAll sozinha).
// Num DMI sem states o laço não itera: a troca é livre e não converte nada.
function resizeDocIcons(W, H, mode, ax = 0.5, ay = 0.5) {
  const ow = doc.width, oh = doc.height;
  for (const st of doc.states) {
    st.frames = st.frames.map((f) =>
      mode === 'scale'
        ? P.scaleNearest(f, ow, oh, W, H)
        : P.placed(f, ow, oh, W, H, Math.round((W - ow) * ax), Math.round((H - oh) * ay))
    );
    dropTrim(st); // os buffers guardados são do icon size antigo
  }
  doc.width = W;
  doc.height = H;
}

$('btnResizeOk').onclick = () => {
  if (!doc) return;
  const W = Math.max(1, Math.min(512, +$('rW').value));
  const H = Math.max(1, Math.min(512, +$('rH').value));
  if (W === doc.width && H === doc.height) return;
  const mode = document.querySelector('input[name="rmode"]:checked').value;
  const [ax, ay] = $('rAnchor').value.split(',').map(Number);
  structural(() => resizeDocIcons(W, H, mode, ax, ay));
  fitZoom();
  refreshAll();
  toast(`DMI agora é ${W}×${H}`);
};

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
  if (!doc || !curState()) return;
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

// ---------------------------------------------------------------- import de imagem
//
// PNG vai pro servidor (nosso codec, byte a byte, sem canvas — a invariante do projeto).
// Os outros formatos o browser decodifica com a API ImageDecoder (WebCodecs), que devolve
// RGBA cru (nao premultiplicado) SEM passar por canvas. Fallback pra createImageBitmap +
// canvas so' quando o browser nao tem ImageDecoder — ai' avisamos no diálogo.

const MAX_SRC_FRAMES = 120;
const MAX_SRC_BYTES = 192 << 20; // teto de memoria da fonte (GIF grande trava a aba)

// O tipo sai do MAGIC BYTE: file.type vem vazio em vários drops e a extensão mente.
function sniffImageType(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'; // "GIF8"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d && isBmpHeader(b)) return 'image/bmp';
  return null;
}

// "BM" sao 2 bytes fraquissimos (qualquer lixo binario passaria), entao confere tambem o
// tamanho declarado e o tamanho do cabecalho DIB.
function isBmpHeader(b) {
  if (b.length < 18) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const declared = dv.getUint32(2, true);
  const dib = dv.getUint32(14, true);
  return Math.abs(declared - b.length) <= 2 && [12, 40, 52, 56, 64, 108, 124].includes(dib);
}

// APNG: PNG com chunk acTL. Nosso decodePng leria so' o 1o quadro e perderia a animacao
// em silencio, entao um APNG e' roteado pro ImageDecoder.
function hasACTL(b) {
  for (let o = 8; o + 8 <= b.length; ) {
    const len = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, false);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    o += 12 + len;
  }
  return false;
}

// duration vem em MICROssegundos. Delay da BYOND e' em decimos de segundo, e o formato
// aceita fracao (o editor inteiro ja' aceita: pDelay tem step=.5 e o dmi.js grava verbatim).
// Arredondar pra decimo INTEIRO transformaria todo GIF de 20-25fps em 10fps.
const delayTenths = (us) => Math.max(1, Math.round((us || 0) / 10000)) / 10;

// Le um VideoFrame como RGBA empacotado. copyTo NAO garante stride = w*4 (pode vir com
// padding de alinhamento), entao forcamos o layout e, se o UA recusar, desfazemos na mao.
async function frameToRgba(image) {
  const rect = image.visibleRect; // codedWidth pode ter padding; displayWidth carrega aspect ratio
  const w = rect.width, h = rect.height;
  const packed = { format: 'RGBA', rect, layout: [{ offset: 0, stride: w * 4 }] };
  try {
    const px = new Uint8ClampedArray(image.allocationSize(packed));
    await image.copyTo(px, packed);
    return { px, w, h };
  } catch {
    const opts = { format: 'RGBA', rect };
    const buf = new Uint8ClampedArray(image.allocationSize(opts));
    const [plane] = await image.copyTo(buf, opts);
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const s = plane.offset + y * plane.stride;
      px.set(buf.subarray(s, s + w * 4), y * w * 4);
    }
    return { px, w, h };
  }
}

async function decodeWithImageDecoder(bytes, type) {
  // preferAnimation: formatos com track estática + animada (webp/avif) selecionariam a
  // estática e importariam 1 quadro achando que o arquivo não tem animação.
  const dec = new ImageDecoder({ data: bytes, type, preferAnimation: true });
  try {
    await dec.tracks.ready;
    await dec.completed; // sem isso frameCount pode vir 1 e decode() rejeita com RangeError
    const track = dec.tracks.selectedTrack;
    const n = Math.max(1, track?.frameCount ?? 1);
    const rep = track?.repetitionCount ?? 0;

    const first = await dec.decode({ frameIndex: 0 });
    const f0 = await frameToRgba(first.image);
    const W = f0.w, H = f0.h;
    const dur0 = first.image.duration ?? 0;
    first.image.close();

    // subamostra pra caber no teto de memoria, SOMANDO a duracao dos quadros pulados
    // (a animacao mantem a duracao total; so' cai o fps).
    const budget = Math.min(MAX_SRC_FRAMES, Math.max(1, Math.floor(MAX_SRC_BYTES / (W * H * 4))));
    const stride = Math.ceil(n / budget);

    const acc = new Uint8ClampedArray(W * H * 4);
    acc.set(f0.px);
    const srcFrames = [];
    const srcDelays = [];
    let pending = 0;

    const keep = (i, durUs) => {
      pending += durUs || 0;
      if (i % stride !== stride - 1 && i !== n - 1) return;
      srcFrames.push(acc.slice());
      srcDelays.push(delayTenths(pending));
      pending = 0;
    };

    // ordem crescente: GIF e' inter-frame, acesso aleatorio força re-decode (O(n^2))
    keep(0, dur0);
    for (let i = 1; i < n; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const fr = await frameToRgba(image);
      // O Chrome ja' devolve os quadros compostos (disposal aplicado), mas o spec nao
      // obriga: se vier um delta parcial, compomos por cima em vez de emitir lixo.
      if (fr.w === W && fr.h === H) acc.set(fr.px);
      else P.blitOver(acc, W, H, fr.px, fr.w, fr.h, 0, 0);
      keep(i, image.duration);
      image.close();
    }

    if (n > srcFrames.length) {
      toast(`${n} quadros — importando 1 a cada ${stride} (${srcFrames.length} frames), somando os tempos.`);
    }
    return {
      srcFrames, w: W, h: H,
      srcDelays: srcFrames.length > 1 ? srcDelays : null,
      loop: rep === Infinity || rep < 0 ? 0 : Math.max(1, Math.round(rep)),
      viaCanvas: false,
    };
  } finally {
    dec.close();
  }
}

// Fallback: passa por canvas (premultiplica e despremultiplica o alfa) e só lê 1 quadro.
// Exato pra JPEG/BMP (sem alfa) e pra alfa binário; pode variar 1/255 em semitransparente.
async function decodeWithCanvas(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return {
    srcFrames: [new Uint8ClampedArray(img.data)],
    w: img.width, h: img.height,
    srcDelays: null, loop: 0, viaCanvas: true,
  };
}

// PNG estático: caminho exato pelo servidor (lib/png.js), sem canvas, sem browser no meio.
async function decodeViaServer(bytes) {
  const r = await fetch('/api/import/png', { method: 'POST', body: bytes });
  if (!r.ok) throw new Error((await r.json()).error);
  const { header, body } = await decodeEnvelope(r);
  return { srcFrames: [body], w: header.width, h: header.height, srcDelays: null, loop: 0, viaCanvas: false };
}

const hasAnyAlpha = (frames) => frames.some((f) => {
  for (let o = 3; o < f.length; o += 4) if (f[o] < 255) return true;
  return false;
});

$('btnImport').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  if (e.target.files[0]) importImageFile(e.target.files[0]);
  e.target.value = '';
};

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = e.dataTransfer.files;
  if (!files?.length) return;
  if (files.length > 1) toast(`Solte um arquivo por vez — importando só ${files[0].name}.`);
  importImageFile(files[0]);
});

async function importImageFile(file) {
  if (!doc) return toast('Abra ou crie um DMI antes de importar', true);
  impOpening = true;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length) throw new Error('Arquivo vazio.');

    const type = sniffImageType(bytes);
    if (!type) {
      if (file.name.toLowerCase().endsWith('.dmi')) {
        return toast('Para abrir um .dmi use a lista de Arquivos (o navegador não informa o caminho).', true);
      }
      throw new Error(`Formato não suportado: ${file.name}. Aceito PNG, JPEG, WEBP, BMP e GIF.`);
    }

    const exactPath = type === 'image/png' && !hasACTL(bytes);
    let src;
    if (exactPath) {
      src = await decodeViaServer(bytes);
    } else if ('ImageDecoder' in window && (await ImageDecoder.isTypeSupported(type))) {
      src = await decodeWithImageDecoder(bytes, type);
    } else {
      try {
        src = await decodeWithCanvas(new Blob([bytes], { type }));
      } catch {
        throw new Error(`Este navegador não sabe decodificar ${type}. Converta para PNG.`);
      }
    }

    pendingImport = {
      ...src,
      type,
      name: file.name.replace(/\.(png|jpe?g|gif|webp|bmp)$/i, ''),
      animated: src.srcFrames.length > 1,
      hasAlpha: hasAnyAlpha(src.srcFrames),
    };
    const imp = pendingImport;
    impCache = { key: null, frames: null };

    // grade default: a grade REAL quando a imagem é múltipla do icon size (não 1×1)
    const alignedC = !imp.animated && imp.w % doc.width === 0 ? imp.w / doc.width : 0;
    const alignedR = !imp.animated && imp.h % doc.height === 0 ? imp.h / doc.height : 0;
    const aligned = alignedC > 0 && alignedR > 0;

    $('impInfo').textContent =
      `${file.name} — ${imp.w}×${imp.h}` +
      (imp.animated ? ` · ${imp.srcFrames.length} quadros` : '') +
      (type === 'image/jpeg' ? ' · JPEG tem artefato de compressão: considere reduzir as cores.' : '') +
      (imp.viaCanvas ? ' · decodificado pelo canvas (este navegador não tem WebCodecs): sem animação, e pixels semitransparentes podem variar 1/255.' : '');

    // a grade é explícita (origem + célula + contagem); a default é a grade REAL quando a
    // imagem é múltipla do icon size, senão a imagem inteira numa célula só
    $('impCols').value = aligned ? alignedC : 1;
    $('impRows').value = aligned ? alignedR : 1;
    $('impCellW').value = aligned ? doc.width : imp.w;
    $('impCellH').value = aligned ? doc.height : imp.h;
    $('impCellW').max = imp.w;
    $('impCellH').max = imp.h;
    $('impOffX').value = 0;
    $('impOffY').value = 0;
    for (const id of ['impCols', 'impRows', 'impCellW', 'impCellH', 'impOffX', 'impOffY']) {
      $(id).disabled = imp.animated;
      $(id).title = imp.animated ? 'Fonte animada: cada quadro do arquivo já é um frame.' : '';
    }
    impZoomAt = 0;
    $('impSetSize').checked = false;
    // opções voltam ao padrão a cada arquivo: herdar a paleta/tolerância do import anterior
    // mudaria as cores do novo em silêncio
    $('impColors').value = 0;
    $('impTol').value = 12;
    $('impTolV').textContent = 12;
    impSkip.clear();
    impSkipTotal = -1;
    impBgManual = false;
    document.querySelector(`input[name="imode"][value="${aligned ? 'slice' : 'reduce'}"]`).checked = true;

    // Sem alfa nenhum (JPEG/BMP sempre) o fundo vem opaco — mas só oferecemos remover
    // sozinho quando a cor da borda é DOMINANTE: numa foto o "fundo" não é chapado e o
    // flood automático mutilaria a imagem.
    const stats = P.boundaryStats(imp.srcFrames[0], imp.w, imp.h);
    const autoBg = !imp.hasAlpha && stats.color && stats.share >= 0.6;
    document.querySelector(`input[name="ibg"][value="${autoBg ? 'flood' : 'none'}"]`).checked = true;
    if (stats.color) $('impBgColor').value = rgb2hex(stats.color);

    // showModal() ANTES de desenhar: o painel da fonte se ajusta ao espaço disponível, e um
    // <dialog> fechado é display:none — mediria 0.
    $('dlgImport').showModal();
    impOpening = false;
    drawImportSource(); // a imagem da fonte é pintada UMA vez por arquivo
    await refreshImport();
  } catch (err) {
    impOpening = false;
    toast(err.message, true);
  }
}

// O 'close' do <dialog> é ASSÍNCRONO e pode chegar MUITO depois — inclusive já com o PRÓXIMO
// import aberto. Marcar a sessão no listener não basta: o evento atrasado é entregue a TODOS os
// listeners registrados até ali, inclusive o do import novo, que então apagaria o próprio
// estado (o import seguinte simplesmente parava de responder — bug real, flagrado no smoke).
// A pergunta certa não é "de quem é esse evento?", e sim "tem import aberto agora?".
$('dlgImport').addEventListener('close', () => {
  // "reabriu" inclui o diálogo ainda ABRINDO: o import decodifica a imagem em await, e um
  // 'close' atrasado que caia nessa janela apagaria o estado do import que está nascendo
  if ($('dlgImport').open || impOpening) return;
  pendingImport = null;
  importResult = null;
  impCache = { key: null, frames: null };
  impSkip.clear();
  impSkipTotal = -1;
  impBgManual = false;
});

const impMode = () => document.querySelector('input[name="imode"]:checked').value;
const impBgMode = () => document.querySelector('input[name="ibg"]:checked').value;
const impSingle = () => ['scale', 'center', 'crop'].includes(impMode()); // modos de 1 frame só

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+v || 0)));

// A grade é EXPLÍCITA: origem (offX,offY) + tamanho da célula (cw,ch) + contagem (cols,rows).
// A célula (cx,cy) é o retângulo [offX + cx*cw, offY + cy*ch, cw, ch] — nada de derivar bordas
// de round(cx*w/cols): o overlay desenha exatamente os retângulos que a conversão lê, sem
// arredondar duas vezes, e a grade pode sair da imagem (o que sobra vira transparente).
// Vale pros dois cortadores (fatiar e reduzir). Fonte animada: 1 quadro = 1 frame.
function impGrid() {
  const imp = pendingImport;
  if (imp.animated || impSingle()) {
    return { cols: 1, rows: 1, offX: 0, offY: 0, cw: imp.w, ch: imp.h };
  }
  const cw = clampInt($('impCellW').value, 1, imp.w);
  const ch = clampInt($('impCellH').value, 1, imp.h);
  return {
    cols: clampInt($('impCols').value, 1, 256),
    rows: clampInt($('impRows').value, 1, 256),
    offX: clampInt($('impOffX').value, -cw + 1, imp.w - 1),
    offY: clampInt($('impOffY').value, -ch + 1, imp.h - 1),
    cw,
    ch,
  };
}

const gridKey = (g) => `${g.cols}|${g.rows}|${g.offX}|${g.offY}|${g.cw}|${g.ch}`;

const impCellOk = () => {
  const { cw, ch } = impGrid();
  return cw >= 1 && ch >= 1 && cw <= 512 && ch <= 512;
};

// O alvo da conversão: o icon size do DMI, ou o tamanho da célula quando o usuário pede
// pra adotá-lo como novo icon size.
function impTarget() {
  const { cw, ch } = impGrid();
  return $('impSetSize').checked && !$('impSetSize').disabled
    ? { tw: cw, th: ch }
    : { tw: doc.width, th: doc.height };
}

// "fatiar" (corte byte-exato) só existe quando a célula bate EXATAMENTE com o alvo. Com a grade
// explícita isso não depende mais da imagem ser divisível: sheet com margem também fatia.
function impSliceOk() {
  const imp = pendingImport;
  if (imp.animated || impSingle()) return false;
  const { cw, ch } = impGrid();
  const { tw, th } = impTarget();
  return cw === tw && ch === th;
}

// A cor do fundo é decidida UMA vez, por voto entre as bordas de todos os frames.
// Decidir por frame faria frames da mesma animação limparem cores diferentes (a lição do
// video.py do proper-pixel-art: mesma decisão global pra todos os frames, senão cintila).
function importBgColor(frames, tw, th) {
  if (impBgManual) return hex2rgb($('impBgColor').value);
  const votes = new Map();
  for (const f of frames) {
    const c = P.boundaryColor(f, tw, th);
    if (!c) continue;
    const k = (c.r << 16) | (c.g << 8) | c.b;
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [k, n] of votes) if (n > bestN) { best = k; bestN = n; }
  if (best === null) return null;
  return { r: (best >> 16) & 255, g: (best >> 8) & 255, b: best & 255 };
}

// Recorta um retângulo da fonte que PODE estar fora dela (a grade tem offset e pode passar da
// borda). P.copyRegion não clampa — um x negativo ou uma largura que passa do fim devolve linha
// curta/enviesada, em silêncio. Então: intersecta, copia o que existe e coloca num buffer
// cw×ch transparente.
function cutCell(src, w, h, x0, y0, cw, ch) {
  const ix0 = Math.max(0, x0), iy0 = Math.max(0, y0);
  const ix1 = Math.min(w, x0 + cw), iy1 = Math.min(h, y0 + ch);
  if (ix1 <= ix0 || iy1 <= iy0) return new Uint8ClampedArray(cw * ch * 4); // célula toda fora
  const inner = P.copyRegion(src, w, h, ix0, iy0, ix1 - ix0, iy1 - iy0);
  if (ix0 === x0 && iy0 === y0 && ix1 === x0 + cw && iy1 === y0 + ch) return inner; // toda dentro
  return P.placed(inner, ix1 - ix0, iy1 - iy0, cw, ch, ix0 - x0, iy0 - y0);
}

// Um quadro da fonte -> um ou mais frames no tamanho ALVO (tw × th).
function convertSource(src, w, h, mode, g, tw, th) {
  if (mode === 'slice' || mode === 'reduce') {
    const { cols, rows, offX, offY, cw, ch } = g;
    return Array.from({ length: cols * rows }, (_, k) => {
      const x0 = offX + (k % cols) * cw;
      const y0 = offY + Math.floor(k / cols) * ch;
      const cell = cutCell(src, w, h, x0, y0, cw, ch);
      return mode === 'slice' && cw === tw && ch === th
        ? cell // corte exato: os bytes da célula, intocados
        : P.downsampleDominant(cell, cw, ch, tw, th);
    });
  }
  return [
    mode === 'scale' ? P.scaleNearest(src, w, h, tw, th)
    : mode === 'center' ? P.placed(src, w, h, tw, th, Math.round((tw - w) / 2), Math.round((th - h) / 2))
    : P.placed(src, w, h, tw, th, 0, 0),
  ];
}

// A conversão é o estágio caro (downsampleDominant varre a fonte inteira) e depende só de
// (mode, cols, rows, alvo) — cores, tolerância, fundo e a seleção de células não a afetam.
// Memoizar deixa os sliders e os cliques instantâneos SEM precisar amostrar frames, então o
// preview continua idêntico ao resultado final.
let impCache = { key: null, frames: null };

const impCacheKey = (mode, g, tw, th) => `${mode}|${gridKey(g)}|${tw}|${th}`;

function convertedFrames(mode, g, tw, th) {
  const key = impCacheKey(mode, g, tw, th);
  if (impCache.key !== key) {
    const imp = pendingImport;
    impCache = {
      key,
      frames: imp.srcFrames.flatMap((s) => convertSource(s, imp.w, imp.h, mode, g, tw, th)),
    };
  }
  return impCache.frames;
}

function toggleSkip(i) {
  if (impSkip.has(i)) impSkip.delete(i);
  else impSkip.add(i);
  clearTimeout(impDebounce);
  impDebounce = setTimeout(refreshImport, 60);
}

// Monta os frames conforme as opções atuais do diálogo. Usada tanto pelo preview quanto
// pela aplicação — o preview mostra exatamente o que vai entrar no state.
function buildImportFrames() {
  const imp = pendingImport;
  const mode = impMode();
  const g = impGrid();
  const { tw, th } = impTarget();

  const all = convertedFrames(mode, g, tw, th);

  // a seleção só faz sentido enquanto a geometria não muda
  if (all.length !== impSkipTotal) {
    impSkip.clear();
    impSkipTotal = all.length;
  }

  // clona só o que vai entrar: applyPalette e clearColor* mutam in-place e o cache tem que
  // ficar intacto. As decisões globais (paleta, fundo) veem só os frames escolhidos.
  const kept = [];
  const frames = [];
  all.forEach((f, i) => {
    if (impSkip.has(i)) return;
    kept.push(i);
    frames.push(f.slice());
  });

  const bgMode = impBgMode();
  const tol = +$('impTol').value || 0;
  // Fundo ANTES da paleta: quantizar primeiro deslocaria a cor do fundo e a cor escolhida
  // no picker (que veio da imagem original) não casaria mais com nada.
  const bgColor = bgMode === 'none' || !frames.length ? null : importBgColor(frames, tw, th);
  let cleared = 0;
  if (bgColor) {
    for (const f of frames) {
      cleared += bgMode === 'exact'
        ? P.clearColorExact(f, bgColor, tol)
        : P.clearColorFlood(f, tw, th, bgColor, tol);
    }
  }

  // Paleta: construída sobre TODOS os frames de uma vez (paleta por frame faria a
  // animação trocar de cor a cada frame).
  const numColors = Math.max(0, Math.min(256, +$('impColors').value || 0));
  if (numColors > 0 && frames.length) {
    const palette = P.buildPalette(frames, numColors);
    for (const f of frames) P.applyPalette(f, palette);
  }

  const colors = new Set();
  for (const f of frames) {
    for (let o = 0; o < f.length; o += 4) if (f[o + 3] > 0) colors.add((f[o] << 16) | (f[o + 1] << 8) | f[o + 2]);
  }
  const delays = imp.animated && imp.srcDelays ? kept.map((i) => imp.srcDelays[i]) : null;
  return { all, kept, frames, bgColor, cleared, mode, colors: colors.size, delays, tw, th, g };
}

// ---- render do diálogo ----

// A fonte é pintada UMA vez por arquivo (uma foto de 820×360 é 1.2MB de putImageData). O
// tamanho de exibição vem do espaço disponível no painel — que só existe DEPOIS do showModal()
// (diálogo fechado é display:none e mede 0).
function drawImportSource() {
  const imp = pendingImport;
  const box = $('impSrc').closest('.imp-src');
  const availW = Math.max(160, box.clientWidth - 8);
  const availH = Math.max(160, box.clientHeight - 46); // o rótulo mora embaixo
  const k = Math.min(availW / imp.w, availH / imp.h, 8); // sprite pequeno pode ampliar (até 8x)
  const dw = Math.max(1, Math.round(imp.w * k));
  const dh = Math.max(1, Math.round(imp.h * k));
  const cv = pixelsToCanvas(imp.srcFrames[0], imp.w, imp.h, $('impSrc'));
  cv.style.width = `${dw}px`;
  cv.style.height = `${dh}px`;
  const ov = $('impSrcOv');
  ov.width = dw;   // resolução = pixels de exibição, pra linha sair crispa
  ov.height = dh;
  ov.style.width = `${dw}px`;
  ov.style.height = `${dh}px`;
}

// Overlay: com a grade explícita ele desenha os MESMOS retângulos que a conversão recorta —
// não há fórmula duplicada pra sair de sincronia. O que fica fora da imagem é o que vai virar
// transparente no frame, então precisa aparecer.
function drawImportOverlay(res) {
  const imp = pendingImport;
  const ov = $('impSrcOv');
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, ov.width, ov.height);
  if (imp.animated || impSingle()) return; // 1 célula: nada pra dividir

  const { cols, rows, offX, offY, cw, ch } = res.g;
  const sx = ov.width / imp.w;
  const sy = ov.height / imp.h;
  const X = (x) => (x - 0) * sx;
  const Y = (y) => (y - 0) * sy;

  // o que a grade NÃO cobre fica escurecido: é o que o import vai jogar fora
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.42)';
  ctx.fillRect(0, 0, ov.width, ov.height);
  ctx.clearRect(X(offX), Y(offY), cols * cw * sx, rows * ch * sy);
  ctx.restore();

  for (let i = 0; i < cols * rows; i++) {
    if (!impSkip.has(i)) continue;
    const x0 = X(offX + (i % cols) * cw), y0 = Y(offY + Math.floor(i / cols) * ch);
    const x1 = x0 + cw * sx, y1 = y0 + ch * sy;
    ctx.fillStyle = 'rgba(0,0,0,.62)';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = '#f87171';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0 + 4, y0 + 4); ctx.lineTo(x1 - 4, y1 - 4);
    ctx.moveTo(x1 - 4, y0 + 4); ctx.lineTo(x0 + 4, y1 - 4);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(110, 231, 183, .85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 0; c <= cols; c++) {
    const x = Math.round(X(offX + c * cw)) + 0.5;
    ctx.moveTo(x, Y(offY)); ctx.lineTo(x, Y(offY + rows * ch));
  }
  for (let r = 0; r <= rows; r++) {
    const y = Math.round(Y(offY + r * ch)) + 0.5;
    ctx.moveTo(X(offX), y); ctx.lineTo(X(offX + cols * cw), y);
  }
  ctx.stroke();
}

// Miniaturas de TODOS os frames. O DOM só é reconstruído quando a CONTAGEM muda — alternar
// uma célula só repinta e troca a classe (com 256 miniaturas, recriar tudo piscaria).
function renderImportThumbs(res) {
  const box = $('impThumbs');
  const n = res.all.length;
  if (box.children.length !== n) {
    box.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const c = document.createElement('canvas');
      c.dataset.i = i;
      c.title = 'clique: incluir/excluir este frame · Alt+clique: pegar a cor do fundo';
      c.onclick = (e) => {
        if (e.altKey) return pickBgFromThumb(i);
        toggleSkip(i);
      };
      c.onmouseover = () => setImportZoom(i);
      frag.append(c);
    }
    box.append(frag);
  }
  const done = new Map(res.kept.map((src, k) => [src, res.frames[k]]));
  [...box.children].forEach((c, i) => {
    const px = done.get(i) ?? res.all[i]; // excluído: mostra o cru (sem paleta/fundo)
    c.width = res.tw;
    c.height = res.th;
    c.getContext('2d').putImageData(new ImageData(px, res.tw, res.th), 0, 0);
    c.classList.toggle('off', impSkip.has(i));
  });
}

// Alt+clique numa miniatura pega a cor do frame JÁ CONVERTIDO — mais exato que pegar da
// fonte, onde o branco de um JPEG ainda não virou o tom que a redução vai produzir.
function pickBgFromThumb(i) {
  const res = importResult;
  if (!res) return;
  const k = res.kept.indexOf(i);
  const px = k >= 0 ? res.frames[k] : res.all[i];
  const c = P.getPx(px, res.tw, 0, 0);
  setImportBg(c);
}

function setImportBg(c) {
  $('impBgColor').value = rgb2hex(c);
  impBgManual = true;
  if (impBgMode() === 'none') document.querySelector('input[name="ibg"][value="flood"]').checked = true;
  // a cor veio da imagem original; a conversão pode ter deslocado o tom em 1-2 níveis
  if (+$('impTol').value === 0) $('impTol').value = 12;
  refreshImport();
}

// ---- zoom: um frame grande, do lado do original ----
// Sem isso não dá pra julgar a remoção do fundo: numa miniatura de 40px o que virou
// transparente não aparece. O alvo é GRUDENTO (sair com o mouse não limpa; senão o painel
// piscaria vazio o tempo todo).
let impZoomAt = 0;
let impZoomPx = null; // o frame convertido que está no zoom (pro Alt+clique pegar a cor dele)

function setImportZoom(i) {
  if (i === impZoomAt) return;
  impZoomAt = i;
  if (importResult) renderImportZoom(importResult);
}

// Escala pra caber na caixa (nearest — pixel art ampliada não pode borrar). O tamanho de
// EXIBIÇÃO tem que ser medido da caixa e imposto no style: um canvas sem style tem a largura
// nativa (820px numa foto) e arrastaria a coluna inteira do diálogo junto.
function fitCanvas(cv, px, w, h) {
  pixelsToCanvas(px, w, h, cv);
  const box = cv.parentElement.getBoundingClientRect();
  const bw = Math.max(40, box.width - 8);
  const bh = Math.max(40, box.height - 8);
  const k = Math.max(0.02, Math.min(bw / w, bh / h));
  cv.style.width = `${Math.max(1, Math.floor(w * k))}px`;
  cv.style.height = `${Math.max(1, Math.floor(h * k))}px`;
}

function renderImportZoom(res) {
  const imp = pendingImport;
  if (!imp) return;
  const i = Math.max(0, Math.min(impZoomAt, res.all.length - 1));
  impZoomAt = i;

  const g = res.g;
  const per = g.cols * g.rows;
  const s = Math.floor(i / per);       // qual quadro da FONTE (animação)
  const k = i % per;                   // qual célula dentro dele
  const src = imp.srcFrames[s] ?? imp.srcFrames[0];

  let srcPx, sw, sh;
  if (impSingle()) {
    srcPx = src; sw = imp.w; sh = imp.h;
  } else {
    sw = g.cw; sh = g.ch;
    srcPx = cutCell(src, imp.w, imp.h, g.offX + (k % g.cols) * g.cw, g.offY + Math.floor(k / g.cols) * g.ch, g.cw, g.ch);
  }
  fitCanvas($('impZoomSrc'), srcPx, sw, sh);

  const done = res.kept.indexOf(i);
  impZoomPx = done >= 0 ? res.frames[done] : res.all[i];
  fitCanvas($('impZoomOut'), impZoomPx, res.tw, res.th);

  $('impZoomLbl').textContent =
    `frame ${i + 1} de ${res.all.length} · ${sw}×${sh} → ${res.tw}×${res.th}` +
    (impSkip.has(i) ? ' · EXCLUÍDO' : '') +
    ' · Alt+clique no resultado pega a cor do fundo';
}

// Alt+clique no resultado: a cor já passou pela redução — é exatamente o tom que o clearColor*
// vai comparar (pegar da fonte devolveria o #ffffff que virou #fefdfe depois da mediana).
$('impZoomOut').onclick = (e) => {
  const res = importResult;
  if (!e.altKey || !res || !impZoomPx) return;
  const r = e.currentTarget.getBoundingClientRect();
  const x = Math.max(0, Math.min(res.tw - 1, Math.floor(((e.clientX - r.left) / r.width) * res.tw)));
  const y = Math.max(0, Math.min(res.th - 1, Math.floor(((e.clientY - r.top) / r.height) * res.th)));
  setImportBg(P.getPx(impZoomPx, res.tw, x, y));
};

// ---- fonte: clique (célula), Alt+clique (cor) e ARRASTO (offset da grade) ----

const impSrcPos = (e) => {
  const imp = pendingImport;
  const r = $('impSrcOv').getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(imp.w - 1, Math.floor(((e.clientX - r.left) / r.width) * imp.w))),
    y: Math.max(0, Math.min(imp.h - 1, Math.floor(((e.clientY - r.top) / r.height) * imp.h))),
    scale: imp.w / r.width, // px da fonte por px de tela
  };
};

// a célula sob um ponto da fonte (null = fora da grade)
function impCellAt(px, py) {
  const g = impGrid();
  const cx = Math.floor((px - g.offX) / g.cw);
  const cy = Math.floor((py - g.offY) / g.ch);
  if (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) return null;
  return cy * g.cols + cx;
}

let impDrag = null;      // arrasto em andamento
let impDragged = false;  // arrastou: o 'click' que vem em seguida NÃO é um toggle

$('impSrcOv').onmousedown = (e) => {
  const imp = pendingImport;
  if (!imp || e.altKey || imp.animated || impSingle()) return;
  const p = impSrcPos(e);
  const g = impGrid();
  impDrag = { x: e.clientX, y: e.clientY, offX: g.offX, offY: g.offY, scale: p.scale };
  impDragged = false;
};

window.addEventListener('mousemove', (e) => {
  if (!impDrag) return;
  const dx = e.clientX - impDrag.x;
  const dy = e.clientY - impDrag.y;
  if (!impDragged && Math.abs(dx) < 3 && Math.abs(dy) < 3) return; // ainda pode virar clique
  impDragged = true;
  $('impOffX').value = impDrag.offX + Math.round(dx * impDrag.scale);
  $('impOffY').value = impDrag.offY + Math.round(dy * impDrag.scale);
  clearTimeout(impDebounce);
  impDebounce = setTimeout(refreshImport, 30);
});

window.addEventListener('mouseup', () => { impDrag = null; });

$('impSrcOv').onmousemove = (e) => {
  const imp = pendingImport;
  if (!imp || impDrag) return;
  const p = impSrcPos(e);
  const cell = imp.animated || impSingle() ? 0 : impCellAt(p.x, p.y);
  if (cell !== null) setImportZoom(cell); // o zoom acompanha o mouse na fonte
};

$('impSrcOv').onclick = (e) => {
  const imp = pendingImport;
  if (!imp) return;
  if (impDragged) { impDragged = false; return; } // foi arrasto de grade, não clique
  const p = impSrcPos(e);

  if (e.altKey) return setImportBg(P.getPx(imp.srcFrames[0], imp.w, p.x, p.y)); // antes do toggle!
  if (imp.animated || impSingle()) return;

  const cell = impCellAt(p.x, p.y);
  if (cell !== null) toggleSkip(cell);
};

// Guarda de geração: a primeira conversão de um GIF grande demora, e o usuário pode trocar
// de modo no meio — o refresh velho tem que ser descartado, não sobrescrever o novo.
let impGen = 0;

async function refreshImport() {
  if (!doc || !pendingImport) return;
  const my = ++impGen;
  const imp = pendingImport;

  const g = impGrid();
  const { cols, rows, offX, offY, cw, ch } = g;
  const { tw, th } = impTarget();

  // os campos passam a mostrar os valores JÁ clampados (senão a grade desenhada não bate com
  // o que está escrito)
  if (!imp.animated && !impSingle()) {
    for (const [id, v] of [['impCols', cols], ['impRows', rows], ['impCellW', cw], ['impCellH', ch], ['impOffX', offX], ['impOffY', offY]]) {
      if (+$(id).value !== v) $(id).value = v;
    }
  }

  $('impCells').hidden = imp.animated ? false : impSingle();
  $('impTolV').textContent = $('impTol').value;
  $('impBgRow').hidden = impBgMode() === 'none';

  // "usar a célula como icon size": só faz sentido se ela for válida e diferente da atual
  const sameSize = cw === doc.width && ch === doc.height;
  $('impSetSize').disabled = impSingle() || sameSize || !impCellOk();
  if ($('impSetSize').disabled) $('impSetSize').checked = false;
  $('impCellLbl').textContent = `${cw}×${ch}`;
  $('impSetSizeWrap').title = !impCellOk()
    ? `Célula de ${cw}×${ch} está fora do limite de 1–512`
    : sameSize ? 'A célula já tem o tamanho do ícone' : '';
  // num DMI vazio não há frame pra converter: a troca é livre e silenciosa
  $('impFitWrap').hidden = !$('impSetSize').checked || !doc.states.length;

  // "fatiar" liga/desliga sozinho conforme a grade e o alvo — fica visível e desabilitado,
  // com o motivo no rótulo (sumir deixaria o usuário sem entender por que o corte exato foi embora)
  const sliceOk = impSliceOk();
  const sliceRadio = document.querySelector('input[name="imode"][value="slice"]');
  sliceRadio.disabled = !sliceOk;
  if (!sliceOk && sliceRadio.checked) document.querySelector('input[name="imode"][value="reduce"]').checked = true;
  $('impSliceLbl').textContent = sliceOk
    ? `fatiar (corte exato ${tw}×${th})`
    : `fatiar (indisponível: a célula não é ${tw}×${th})`;

  if (cols * rows > 256) {
    $('btnImpOk').disabled = true;
    $('impPrevLbl').textContent = `${cols * rows} células é demais — reduza colunas/linhas`;
    $('impThumbs').innerHTML = '';
    return;
  }

  const heavy = impCache.key !== impCacheKey(impMode(), g, tw, th);
  if (heavy && imp.srcFrames.length * imp.w * imp.h > 4e6) {
    $('impPrevLbl').textContent = 'processando…';
    await new Promise((r) => setTimeout(r, 0)); // deixa o browser pintar antes do laço pesado
    if (my !== impGen) return;
  }

  const res = buildImportFrames();
  if (my !== impGen) return; // um refresh mais novo venceu
  importResult = res;
  const total = res.frames.length;

  // Direções: escondido quando a fonte é animada — ofereceria "4 direções (1 frame)" pra um
  // GIF de 4 quadros, reinterpretando a animação como as direções de um ícone estático.
  $('impDirsWrap').hidden = total < 2 || imp.animated;
  const sDirs = $('impDirs');
  const prev = +sDirs.value || 1;
  sDirs.innerHTML = '';
  for (const d of [1, 4, 8]) if (total % d === 0) sDirs.add(new Option(`${d} (${total / d} frames)`, d));
  sDirs.value = [...sDirs.options].some((o) => +o.value === prev) ? prev : 1;

  drawImportOverlay(res);
  renderImportThumbs(res);
  renderImportZoom(res);

  $('btnImpOk').disabled = total === 0;
  const secs = res.delays ? ` · ${res.delays.reduce((n, d) => n + d, 0).toFixed(1)}s` : '';
  $('impPrevLbl').textContent = total === 0
    ? 'nenhuma célula selecionada'
    : `${total} de ${res.all.length} frames · ${tw}×${th} · ${res.colors} cores` + secs;

  const dirsWarn = +sDirs.value > 1 && impSkip.size ? ' As células entram na ordem frame×direção: excluir uma desloca as seguintes.' : '';
  $('impSrcLbl').textContent =
    `${imp.w}×${imp.h}` +
    (imp.animated || impSingle()
      ? ''
      : ` · células de ${cw}×${ch} em (${offX},${offY}) · arraste pra deslocar a grade · clique numa célula pra excluir`) +
    ' · Alt+clique pega a cor do fundo' + dirsWarn;

  const c = res.bgColor;
  $('impBgInfo').innerHTML =
    impBgMode() === 'none' ? 'O alfa da imagem é preservado como está.'
    : c ? `Fundo <span class="imp-swatch" style="background:${rgb2hex(c)}"></span> ${rgb2hex(c)} `
        + `(${impBgManual ? 'escolhido por você' : 'detectado na borda'}) — ${res.cleared} pixels limpos.`
    : 'Nenhuma cor opaca na borda: a imagem já tem fundo transparente.';
}

for (const el of document.querySelectorAll('input[name="imode"], input[name="ibg"]')) {
  el.onchange = () => {
    if (impSingle()) impSkip.clear(); // 1 frame só: uma exclusão herdada esvaziaria o import
    refreshImport();
  };
}
$('impSetSize').onchange = refreshImport;

// o painel da fonte é elástico: se a janela muda de tamanho, a imagem e a grade têm que
// ser repintadas no novo tamanho de exibição
window.addEventListener('resize', () => {
  if (!pendingImport || !$('dlgImport').open) return;
  drawImportSource();
  refreshImport();
});

// Debounce: os campos disparam a cada tecla (digitar "16" converteria com "1" antes),
// e o range de tolerância dispara continuamente enquanto arrasta.
let impDebounce = null;
const impRefreshSoon = (ms = 80) => {
  clearTimeout(impDebounce);
  impDebounce = setTimeout(refreshImport, ms);
};

// Colunas/linhas e tamanho da célula são a MESMA grade vista de dois jeitos: editar um lado
// recalcula o outro. O offset não mexe em nenhum dos dois — nudge é nudge (a grade pode passar
// da borda; o que sai vira transparente).
const impLink = {
  impCols: () => $('impCellW').value = Math.max(1, Math.floor((pendingImport.w - impGrid().offX) / impGrid().cols)),
  impRows: () => $('impCellH').value = Math.max(1, Math.floor((pendingImport.h - impGrid().offY) / impGrid().rows)),
  impCellW: () => $('impCols').value = clampInt(Math.floor((pendingImport.w - impGrid().offX) / impGrid().cw), 1, 256),
  impCellH: () => $('impRows').value = clampInt(Math.floor((pendingImport.h - impGrid().offY) / impGrid().ch), 1, 256),
};

for (const id of ['impCols', 'impRows', 'impCellW', 'impCellH', 'impOffX', 'impOffY', 'impColors', 'impTol']) {
  $(id).oninput = () => {
    $('impTolV').textContent = $('impTol').value;
    if (impLink[id] && pendingImport && $(id).value !== '') impLink[id]();
    impRefreshSoon();
  };
}

$('impBgColor').oninput = () => {
  impBgManual = true;
  clearTimeout(impDebounce);
  impDebounce = setTimeout(refreshImport, 80);
};
$('btnImpBgAuto').onclick = (e) => {
  e.preventDefault(); // está dentro de <form method="dialog">: sem isso, o diálogo fecharia
  impBgManual = false;
  refreshImport();
};
$('btnImpAll').onclick = (e) => {
  e.preventDefault();
  const n = importResult?.all.length ?? 0;
  if (impSkip.size) impSkip.clear();
  else for (let i = 0; i < n; i++) impSkip.add(i);
  refreshImport();
};

const IMP_MODE_LABEL = {
  slice: 'fatiado (corte exato)',
  reduce: 'reduzido por cor dominante',
  scale: 'redimensionado (nearest)',
  center: 'centralizado',
  crop: 'alinhado no canto',
};

// Tudo acontece AQUI, no clique do OK — não no evento 'close' do <dialog>, que é assíncrono.
// Dois motivos: (1) o confirm() precisa poder ABORTAR o fechamento (no 'close' o diálogo já
// teria fechado e quem cancelasse o confirm perderia o import inteiro); (2) o 'close' chega
// tarde demais (ou nem chega) num browser headless, e o efeito ficaria à mercê disso.
$('btnImpOk').onclick = (e) => {
  const imp = pendingImport;
  const res = importResult;
  if (!doc || !imp || !res || !res.frames.length) {
    e.preventDefault();
    return toast('Nenhuma célula selecionada', true);
  }
  if ((res.tw !== doc.width || res.th !== doc.height) && doc.states.length) {
    const nf = doc.states.reduce((n, s) => n + s.frames.length, 0);
    const how = $('impFit').value === 'scale' ? 'escalados (nearest)' : 'centralizados, sem redimensionar';
    const okToResize = confirm(
      `Trocar o tamanho do ícone deste DMI de ${doc.width}×${doc.height} para ${res.tw}×${res.th}.\n\n` +
      `Os ${nf} frame(s) dos ${doc.states.length} state(s) que já existem serão ${how}.\n` +
      `(Ctrl+Z desfaz tudo de uma vez.)\n\nContinuar?`
    );
    if (!okToResize) return e.preventDefault(); // o diálogo NÃO fecha: volta pras opções
  }
  applyImport(imp, res);
};

function applyImport(imp, res) {
  const dirs = imp.animated ? 1 : res.frames.length > 1 ? +$('impDirs').value || 1 : 1;
  const resized = res.tw !== doc.width || res.th !== doc.height;
  const fit = $('impFit').value;
  gridSel.clear();
  structural(() => {
    // o resize e o state novo no MESMO structural: um Ctrl+Z desfaz os dois, atomicamente
    if (resized) resizeDocIcons(res.tw, res.th, fit);
    const frameCount = res.frames.length / dirs;
    doc.states.push({
      name: imp.name, dirs, frameCount,
      delays: res.delays ? res.delays.slice(0, frameCount) : frameCount > 1 ? new Array(frameCount).fill(1) : [],
      loop: imp.animated ? imp.loop : 0,
      rewind: false, movement: false, hotspots: [], frames: res.frames,
    });
    sel = { s: doc.states.length - 1, f: 0, d: 0 };
  });
  if (resized) {
    fitZoom();
    renderEditor();
  }
  docColors = collectDocColors(doc);
  renderPalette();
  const detail = [
    `${res.frames.length} frame(s)`,
    IMP_MODE_LABEL[res.mode],
    resized ? `ícone agora é ${res.tw}×${res.th}` : null,
    `${res.colors} cores`,
    res.bgColor ? `fundo removido (${res.cleared}px)` : null,
  ].filter(Boolean).join(', ');
  toast(`Importado como state "${imp.name}" — ${detail}`);
}

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

const exportBase = () => `${doc.name}_${(curState()?.name || 'state').replace(/[^\w-]+/g, '_')}`;

$('btnExpGif').onclick = async () => {
  if (!doc) return;
  if (!curState()) return toast('Este DMI não tem state pra exportar', true);
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
  if (!curState()) return toast('Este DMI não tem frame pra exportar', true);
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
  const st = curState();
  if (!doc || !st) {
    clearPreview(); // nada aberto, ou DMI sem state
    return;
  }
  if (selRect || floating) renderEditor(); // anima o tracejado da seleção

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
    else if (k === 'a' && doc && curState()) {
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
  if (!doc || !curState()) return;

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
