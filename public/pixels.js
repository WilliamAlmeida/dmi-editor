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

// ---- reducao inteligente (port do proper-pixel-art, MIT — Kenneth Allen) ----
//
// Fonte "estilo pixel art" em alta resolucao (gerada por IA, screenshot da web) tem o
// pixel logico borrado, com ruido e sangramento de borda. scaleNearest amostra UM pixel
// por celula, entao pega justamente o ruido. Aqui cada celula vira a cor DOMINANTE dos
// seus pixels, o que descarta o ruido sem inventar cor nova (nada de media/blur).

const BIN_SIZE = 52;        // largura do bin RGB (=> 5 bins por canal)
const ALPHA_THRESHOLD = 128; // alfa >= isso conta como opaco
const MAJORITY = 0.5;        // celula com >= 50% de pixels transparentes vira transparente

// Mediana por canal de uma lista de RGB (usada nos casos pequenos e no bin vencedor).
// Par: media dos dois do meio com floor — igual ao numpy do projeto original.
function medianRgb(rs, gs, bs) {
  const mid = (arr) => {
    arr.sort((a, b) => a - b);
    const n = arr.length;
    return Math.floor((arr[(n - 1) >> 1] + arr[n >> 1]) / 2);
  };
  return { r: mid(rs), g: mid(gs), b: mid(bs) };
}

// Cor dominante de um conjunto de pixels opacos, por binning com offset.
// O espaco RGB e' fatiado em bins de binSize em DOIS grids: o normal e um deslocado meio
// bin. Vence o grid cujo bin mais cheio for maior. Os dois grids existem porque um cluster
// de cor que cai em cima da fronteira de um grid (e seria partido ao meio) fica inteiro no
// outro. A cor devolvida e' a mediana do bin vencedor — robusta a outliers dentro do bin.
// rs/gs/bs: arrays paralelos de canais dos pixels opacos.
function dominantRgb(rs, gs, bs, binSize = BIN_SIZE) {
  const n = rs.length;
  if (n === 1) return { r: rs[0], g: gs[0], b: bs[0] };
  if (n <= 3) return medianRgb([...rs], [...gs], [...bs]);

  const nb = Math.floor(255 / binSize) + 1;
  const off = binSize >> 1;
  const counts1 = new Int32Array(nb * nb * nb);
  const counts2 = new Int32Array(nb * nb * nb);
  const idx1 = new Int32Array(n);
  const idx2 = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    const r1 = Math.floor(rs[i] / binSize), g1 = Math.floor(gs[i] / binSize), b1 = Math.floor(bs[i] / binSize);
    // clamp em 255 ANTES de dividir (senao o deslocamento estoura o ultimo bin)
    const r2 = Math.floor(Math.min(rs[i] + off, 255) / binSize);
    const g2 = Math.floor(Math.min(gs[i] + off, 255) / binSize);
    const b2 = Math.floor(Math.min(bs[i] + off, 255) / binSize);
    idx1[i] = (r1 * nb + g1) * nb + b1;
    idx2[i] = (r2 * nb + g2) * nb + b2;
    counts1[idx1[i]]++;
    counts2[idx2[i]]++;
  }

  let dom1 = 0, max1 = -1, dom2 = 0, max2 = -1;
  for (let k = 0; k < counts1.length; k++) {
    if (counts1[k] > max1) { max1 = counts1[k]; dom1 = k; }
    if (counts2[k] > max2) { max2 = counts2[k]; dom2 = k; }
  }

  const useFirst = max1 >= max2;
  const idx = useFirst ? idx1 : idx2;
  const dom = useFirst ? dom1 : dom2;

  const rs2 = [], gs2 = [], bs2 = [];
  for (let i = 0; i < n; i++) {
    if (idx[i] === dom) { rs2.push(rs[i]); gs2.push(gs[i]); bs2.push(bs[i]); }
  }
  return medianRgb(rs2, gs2, bs2);
}

// Reduz src (sw x sh) para dw x dh pegando a cor dominante de cada celula da malha.
// A malha e' uniforme (o icon size do DMI e' conhecido), entao nao precisamos detectar as
// linhas com Canny/Hough como o projeto original — so' fatiar em dw x dh celulas.
// Celula com maioria de pixels transparentes vira totalmente transparente.
export function downsampleDominant(src, sw, sh, dw, dh, opts = {}) {
  const { binSize = BIN_SIZE, alphaThreshold = ALPHA_THRESHOLD, majority = MAJORITY } = opts;
  const dst = new Uint8ClampedArray(dw * dh * 4);
  const rs = [], gs = [], bs = [];

  for (let cy = 0; cy < dh; cy++) {
    const y0 = Math.round((cy * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.round(((cy + 1) * sh) / dh));
    for (let cx = 0; cx < dw; cx++) {
      const x0 = Math.round((cx * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.round(((cx + 1) * sw) / dw));

      rs.length = gs.length = bs.length = 0;
      let total = 0;
      for (let y = y0; y < y1 && y < sh; y++) {
        for (let x = x0; x < x1 && x < sw; x++) {
          const o = idx(sw, x, y);
          total++;
          if (src[o + 3] >= alphaThreshold) {
            rs.push(src[o]);
            gs.push(src[o + 1]);
            bs.push(src[o + 2]);
          }
        }
      }

      const d = idx(dw, cx, cy);
      if (total === 0 || rs.length <= total * (1 - majority)) continue; // fica transparente
      const c = dominantRgb(rs, gs, bs, binSize);
      dst[d] = c.r;
      dst[d + 1] = c.g;
      dst[d + 2] = c.b;
      dst[d + 3] = 255;
    }
  }
  return dst;
}

// ---- quantizacao de paleta (median cut) ----
//
// A reducao dominante tira o ruido de DENTRO da celula, mas cada celula ainda decide sua
// mediana sozinha — numa fonte suja isso deixa dezenas de tons quase iguais (ex: 286 cores
// onde o sprite original tinha 24). Reduzir a paleta junta esses tons de volta.
// A paleta e' construida a partir de TODOS os frames de uma vez: paleta por frame faria a
// animacao mudar de cor a cada frame.

export function buildPalette(frameList, numColors) {
  const pts = [];
  for (const px of frameList) {
    for (let o = 0; o < px.length; o += 4) {
      if (px[o + 3] > 0) pts.push([px[o], px[o + 1], px[o + 2]]);
    }
  }
  if (!pts.length) return [];

  // median cut: parte sempre a caixa de maior amplitude, no canal de maior amplitude
  let boxes = [pts];
  while (boxes.length < numColors) {
    let bi = -1, bestRange = 0, bestCh = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      for (let ch = 0; ch < 3; ch++) {
        let mn = 255, mx = 0;
        for (const p of box) {
          if (p[ch] < mn) mn = p[ch];
          if (p[ch] > mx) mx = p[ch];
        }
        if (mx - mn > bestRange) { bestRange = mx - mn; bi = i; bestCh = ch; }
      }
    }
    if (bi < 0) break; // todas as caixas ja' sao de cor unica
    const box = boxes[bi];
    box.sort((a, b) => a[bestCh] - b[bestCh]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }

  // Cada caixa e' representada pela cor MAIS FREQUENTE dentro dela, nao pela media: a media
  // inventaria uma cor que nao existe na fonte (juntar preto e vermelho daria um marrom que
  // nao esta' no sprite). Toda cor da paleta e' uma cor real da imagem.
  return boxes.map((box) => {
    const counts = new Map();
    let best = box[0], bestN = 0;
    for (const p of box) {
      const key = (p[0] << 16) | (p[1] << 8) | p[2];
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n > bestN) { bestN = n; best = p; }
    }
    return { r: best[0], g: best[1], b: best[2] };
  });
}

// Mapeia cada pixel opaco pra cor mais proxima da paleta (alfa intocado).
export function applyPalette(px, palette) {
  if (!palette.length) return;
  for (let o = 0; o < px.length; o += 4) {
    if (px[o + 3] === 0) continue;
    let best = palette[0], bestD = Infinity;
    for (const c of palette) {
      const dr = px[o] - c.r, dg = px[o + 1] - c.g, db = px[o + 2] - c.b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = c; }
    }
    px[o] = best.r;
    px[o + 1] = best.g;
    px[o + 2] = best.b;
  }
}

// ---- remocao de fundo ----

// Cor mais frequente na borda de 1px (so' pixels opacos) + que FRACAO da borda ela ocupa.
// O share separa "sprite em fundo chapado" (share ~1) de "foto" (share ~0.1): so' faz
// sentido oferecer remocao automatica de fundo no primeiro caso.
// color = null quando a borda ja' e' toda transparente (nao ha' fundo pra remover).
export function boundaryStats(px, w, h, alphaThreshold = ALPHA_THRESHOLD) {
  const counts = new Map();
  let total = 0;
  const add = (x, y) => {
    const o = idx(w, x, y);
    total++;
    if (px[o + 3] < alphaThreshold) return;
    const key = (px[o] << 16) | (px[o + 1] << 8) | px[o + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { add(0, y); add(w - 1, y); }

  let best = null, bestN = 0;
  for (const [key, n] of counts) if (n > bestN) { best = key; bestN = n; }
  if (best === null) return { color: null, share: 0 };
  return {
    color: { r: (best >> 16) & 255, g: (best >> 8) & 255, b: best & 255 },
    share: total ? bestN / total : 0,
  };
}

export const boundaryColor = (px, w, h, alphaThreshold = ALPHA_THRESHOLD) =>
  boundaryStats(px, w, h, alphaThreshold).color;

// Fundo de imagem gerada por IA nunca e' uma cor chapada: vem com ruido, entao comparar
// RGB exato deixa metade dele pra tras. tol = diferenca maxima por canal (0 = exato).
const nearColor = (px, o, c, tol) =>
  Math.abs(px[o] - c.r) <= tol && Math.abs(px[o + 1] - c.g) <= tol && Math.abs(px[o + 2] - c.b) <= tol;

// Zera o alfa de TODOS os pixels dessa cor, onde quer que estejam (e' o que o
// proper-pixel-art faz). Some com o fundo de uma vez, mas tambem come pixels da mesma cor
// dentro do sprite — ex: o branco do olho, se o fundo for branco.
export function clearColorExact(px, from, tol = 0) {
  let n = 0;
  for (let o = 0; o < px.length; o += 4) {
    if (px[o + 3] > 0 && nearColor(px, o, from, tol)) {
      px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0;
      n++;
    }
  }
  return n;
}

// Zera o alfa so' da regiao CONECTADA a' borda (flood 4-conexo a partir das bordas).
// Preserva pixels da mesma cor cercados pelo sprite. O flood ATRAVESSA pixels que ja' sao
// transparentes (sem contar), senao um pedaco de fundo alcancavel so' por uma regiao ja'
// transparente ficaria pra tras.
export function clearColorFlood(px, w, h, from, tol = 0) {
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push([x, 0], [x, h - 1]);
  for (let y = 0; y < h; y++) stack.push([0, y], [w - 1, y]);

  let n = 0;
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const k = y * w + x;
    if (seen[k]) continue;
    const o = idx(w, x, y);
    const transparent = px[o + 3] === 0;
    if (!transparent && !nearColor(px, o, from, tol)) continue;
    seen[k] = 1;
    if (!transparent) {
      px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0;
      n++;
    }
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return n;
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

// ---- autotile (adaptado do texel-studio, Emir Yaman Sivrikaya — source-available) ----
//
// Gera a variante de um tile pra um conjunto de lados EXPOSTOS (= sem vizinho).
// Tres efeitos por pixel, na ordem (cada um le' o resultado do anterior):
//   1. sombreamento: clareia a faixa junto ao topo/esquerda expostos, escurece baixo/direita
//      (topo/esquerda recebem luz; a faixa e' 1/5 do lado menor, com decaimento linear);
//   2. contorno: escurece `outline` px das bordas expostas;
//   3. canto: onde DOIS lados expostos se encontram, arredonda (os pixels do triangulo
//      x+y < corner viram transparentes).
// Pixels quase transparentes (a < 25) nao sao tocados. exp = {top,bottom,left,right}.
export function autotileVariant(src, w, h, exp, opts = {}) {
  const {
    intensity = 0.15,
    outline = Math.max(1, Math.min(w, h) >> 4),
    corner = Math.max(1, Math.round(Math.min(w, h) / 10)),
    darken = 0.4,
  } = opts;
  const band = Math.max(2, Math.round(Math.min(w, h) / 5));
  const px = src.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = idx(w, x, y);
      if (px[o + 3] < 25) continue;
      const db = h - 1 - y, dr = w - 1 - x;

      if (corner > 0 && (
        (exp.top && exp.left && x + y < corner) ||
        (exp.top && exp.right && dr + y < corner) ||
        (exp.bottom && exp.left && x + db < corner) ||
        (exp.bottom && exp.right && dr + db < corner)
      )) {
        px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0;
        continue;
      }

      let f = 0;
      if (exp.top && y < band) f += intensity * (1 - y / band);
      if (exp.left && x < band) f += intensity * 0.6 * (1 - x / band);
      if (exp.bottom && db < band) f -= intensity * (1 - db / band);
      if (exp.right && dr < band) f -= intensity * 0.6 * (1 - dr / band);
      if (f !== 0) {
        // Uint8ClampedArray clampa sozinho em 0..255
        px[o] += f * 255;
        px[o + 1] += f * 255;
        px[o + 2] += f * 255;
      }

      if (outline > 0 && (
        (exp.top && y < outline) || (exp.bottom && db < outline) ||
        (exp.left && x < outline) || (exp.right && dr < outline)
      )) {
        px[o] *= 1 - darken;
        px[o + 1] *= 1 - darken;
        px[o + 2] *= 1 - darken;
      }
    }
  }
  return px;
}

// ---- fills de textura (ideia do texel-studio; determinismo por semente, nada de Math.random) ----

// Hash inteiro -> [0,1). Mesma (x, y, seed) = mesmo valor, sempre: a textura e' reproduzivel
// e o undo/redo/preview nao "sorteia" outra.
function hashNoise(x, y, seed) {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177) & 0x7fffffff;
  n = n ^ (n >>> 16);
  return (n & 0x7fffffff) / 0x7fffffff;
}

// Distribui as cores da lista pelo retangulo, pixel a pixel, por ruido de hash.
// scale > 1 agrupa (granulacao mais grossa). onlyOpaque preserva o alfa existente
// (so' pinta onde ja' ha' pixel) — sem ele, a area inteira vira opaca.
export function noiseFill(px, w, h, x1, y1, x2, y2, colors, { seed = 42, scale = 1, onlyOpaque = false } = {}) {
  if (!colors.length) return 0;
  let n = 0;
  for (let y = Math.max(0, y1); y <= Math.min(h - 1, y2); y++) {
    for (let x = Math.max(0, x1); x <= Math.min(w - 1, x2); x++) {
      const o = idx(w, x, y);
      if (onlyOpaque && px[o + 3] === 0) continue;
      const v = hashNoise(Math.floor(x / scale), Math.floor(y / scale), seed);
      const c = colors[Math.floor(v * colors.length) % colors.length];
      px[o] = c.r;
      px[o + 1] = c.g;
      px[o + 2] = c.b;
      if (!onlyOpaque) px[o + 3] = 255;
      n++;
    }
  }
  return n;
}

// Padrao de celulas de Voronoi (pedra, cobblestone): `cells` pontos-semente espalhados por
// hash; cada pixel ganha a cor do ponto mais proximo. Cores repetem em ciclo se cells > cores.
export function voronoiFill(px, w, h, x1, y1, x2, y2, colors, { cells = 8, seed = 42, onlyOpaque = false } = {}) {
  if (!colors.length) return 0;
  const rw = x2 - x1 + 1, rh = y2 - y1 + 1;
  const pts = [];
  for (let i = 0; i < cells; i++) {
    pts.push({
      x: x1 + Math.floor(hashNoise(i, 0, seed) * rw),
      y: y1 + Math.floor(hashNoise(0, i, seed + 99) * rh),
      c: colors[i % colors.length],
    });
  }
  let n = 0;
  for (let y = Math.max(0, y1); y <= Math.min(h - 1, y2); y++) {
    for (let x = Math.max(0, x1); x <= Math.min(w - 1, x2); x++) {
      const o = idx(w, x, y);
      if (onlyOpaque && px[o + 3] === 0) continue;
      let best = pts[0], bd = Infinity;
      for (const p of pts) {
        const d = (x - p.x) * (x - p.x) + (y - p.y) * (y - p.y);
        if (d < bd) { bd = d; best = p; }
      }
      px[o] = best.c.r;
      px[o + 1] = best.c.g;
      px[o + 2] = best.c.b;
      if (!onlyOpaque) px[o + 3] = 255;
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
