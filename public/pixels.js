// Operacoes de pixel puras (sem DOM, sem estado global).
// Todos os buffers sao Uint8ClampedArray RGBA de w*h*4 bytes.

export const idx = (w, x, y) => (y * w + x) * 4;

export function getPx(px, w, x, y) {
  const o = idx(w, x, y);
  return { r: px[o], g: px[o + 1], b: px[o + 2], a: px[o + 3] };
}

export function setPx(px, w, h, x, y, c) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const o = idx(w, x, y);
  if (c.a === 0) {
    px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0;
  } else {
    px[o] = c.r;
    px[o + 1] = c.g;
    px[o + 2] = c.b;
    px[o + 3] = c.a;
  }
}

// Carimba um quadrado size x size centrado em (x, y) — espessura do pincel.
export function stamp(px, w, h, x, y, c, size = 1) {
  if (size <= 1) return setPx(px, w, h, x, y, c);
  const o = Math.floor(size / 2);
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) setPx(px, w, h, x - o + dx, y - o + dy, c);
  }
}

export function drawLine(px, w, h, x0, y0, x1, y1, c, size = 1) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    stamp(px, w, h, x0, y0, c, size);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

export function drawRect(px, w, h, x0, y0, x1, y1, c, filled) {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      if (filled || x === ax || x === bx || y === ay || y === by) setPx(px, w, h, x, y, c);
    }
  }
}

export function floodFill(px, w, h, x, y, c) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const target = getPx(px, w, x, y);
  const same = (p) => p.r === target.r && p.g === target.g && p.b === target.b && p.a === target.a;
  if ((target.a === 0 && c.a === 0) || (same(c) && target.a === c.a)) return;

  const stack = [[x, y]];
  const seen = new Uint8Array(w * h);
  while (stack.length) {
    const [cx, cy] = stack.pop();
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
    const k = cy * w + cx;
    if (seen[k]) continue;
    if (!same(getPx(px, w, cx, cy))) continue;
    seen[k] = 1;
    setPx(px, w, h, cx, cy, c);
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
}

// ---- transformacoes (retornam buffer novo) ----

export function flipH(src, w, h) {
  const dst = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = idx(w, w - 1 - x, y);
      dst.set(src.subarray(s, s + 4), idx(w, x, y));
    }
  }
  return dst;
}

export function flipV(src, w, h) {
  const dst = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    const s = (h - 1 - y) * w * 4;
    dst.set(src.subarray(s, s + w * 4), y * w * 4);
  }
  return dst;
}

export function shiftWrap(src, w, h, dx, dy) {
  const dst = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    const ny = (((y + dy) % h) + h) % h;
    for (let x = 0; x < w; x++) {
      const nx = (((x + dx) % w) + w) % w;
      dst.set(src.subarray(idx(w, x, y), idx(w, x, y) + 4), idx(w, nx, ny));
    }
  }
  return dst;
}

export function scaleNearest(src, sw, sh, dw, dh) {
  const dst = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      dst.set(src.subarray(idx(sw, sx, sy), idx(sw, sx, sy) + 4), idx(dw, x, y));
    }
  }
  return dst;
}

// Coloca src num canvas dw x dh transparente, com o canto sup-esq de src em (ox, oy).
// Serve tanto pra cortar (ox negativo) quanto expandir (ox positivo).
export function placed(src, sw, sh, dw, dh, ox, oy) {
  const dst = new Uint8ClampedArray(dw * dh * 4);
  const y0 = Math.max(0, oy);
  const y1 = Math.min(dh, oy + sh);
  const x0 = Math.max(0, ox);
  const x1 = Math.min(dw, ox + sw);
  for (let y = y0; y < y1; y++) {
    const srcOff = idx(sw, x0 - ox, y - oy);
    dst.set(src.subarray(srcOff, srcOff + (x1 - x0) * 4), idx(dw, x0, y));
  }
  return dst;
}

// ---- regiao (selecao) ----

export function copyRegion(src, w, h, x, y, rw, rh) {
  const dst = new Uint8ClampedArray(rw * rh * 4);
  for (let yy = 0; yy < rh; yy++) {
    const s = idx(w, x, y + yy);
    dst.set(src.subarray(s, s + rw * 4), yy * rw * 4);
  }
  return dst;
}

export function clearRegion(px, w, h, x, y, rw, rh) {
  for (let yy = y; yy < y + rh; yy++) {
    if (yy < 0 || yy >= h) continue;
    const x0 = Math.max(0, x);
    const x1 = Math.min(w, x + rw);
    if (x1 > x0) px.fill(0, idx(w, x0, yy), idx(w, x1, yy));
  }
}

// Carimba src (rw x rh) em dst na posicao (ox, oy) com composicao alpha-over.
export function blitOver(dst, w, h, src, rw, rh, ox, oy) {
  for (let yy = 0; yy < rh; yy++) {
    const y = oy + yy;
    if (y < 0 || y >= h) continue;
    for (let xx = 0; xx < rw; xx++) {
      const x = ox + xx;
      if (x < 0 || x >= w) continue;
      const s = (yy * rw + xx) * 4;
      const sa = src[s + 3];
      if (sa === 0) continue;
      const d = idx(w, x, y);
      if (sa === 255) {
        dst[d] = src[s];
        dst[d + 1] = src[s + 1];
        dst[d + 2] = src[s + 2];
        dst[d + 3] = 255;
      } else {
        const da = dst[d + 3];
        const oa = sa + (da * (255 - sa)) / 255;
        for (let k = 0; k < 3; k++) {
          dst[d + k] = (src[s + k] * sa + (dst[d + k] * da * (255 - sa)) / 255) / oa;
        }
        dst[d + 3] = oa;
      }
    }
  }
}

// ---- cor ----

export function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hh;
  if (max === r) hh = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) hh = (b - r) / d + 2;
  else hh = (r - g) / d + 4;
  return [hh / 6, s, l];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hsl2rgb(hh, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, hh + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, hh) * 255),
    Math.round(hue2rgb(p, q, hh - 1 / 3) * 255),
  ];
}

// dh em graus (-180..180); ds/dl em % (-100..100, escala tipo Photoshop)
export function hslAdjust(src, { dh = 0, ds = 0, dl = 0 }) {
  const dst = src.slice();
  for (let o = 0; o < dst.length; o += 4) {
    if (dst[o + 3] === 0) continue;
    let [hh, s, l] = rgb2hsl(dst[o], dst[o + 1], dst[o + 2]);
    hh = (((hh + dh / 360) % 1) + 1) % 1;
    s = ds >= 0 ? s + (1 - s) * (ds / 100) : s * (1 + ds / 100);
    l = dl >= 0 ? l + (1 - l) * (dl / 100) : l * (1 + dl / 100);
    const [r, g, b] = hsl2rgb(hh, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l)));
    dst[o] = r;
    dst[o + 1] = g;
    dst[o + 2] = b;
  }
  return dst;
}

// Troca RGB exato (pixels com alfa > 0), preservando o alfa. Retorna quantos trocou.
export function replaceColor(px, from, to) {
  let n = 0;
  for (let o = 0; o < px.length; o += 4) {
    if (px[o + 3] > 0 && px[o] === from.r && px[o + 1] === from.g && px[o + 2] === from.b) {
      px[o] = to.r;
      px[o + 1] = to.g;
      px[o + 2] = to.b;
      n++;
    }
  }
  return n;
}

// ---- comparacao ----

export function hashFrame(px) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < px.length; i++) {
    hash ^= px[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function framesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
