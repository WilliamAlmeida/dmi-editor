// Encoder GIF89a minimo, sem dependencias.
// Feito para pixel art: paleta global montada com as cores reais dos frames
// (se passar de 255, mantem as mais frequentes e mapeia o resto pra mais proxima).
// frames: Buffer/Uint8Array RGBA (width*height*4). delays em centesimos de segundo.
// loop: 0 = infinito.

function buildPalette(frames) {
  const counts = new Map();
  let hasTrans = false;

  for (const f of frames) {
    for (let o = 0; o < f.length; o += 4) {
      if (f[o + 3] < 128) {
        hasTrans = true;
        continue;
      }
      const key = (f[o] << 16) | (f[o + 1] << 8) | f[o + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const max = hasTrans ? 255 : 256;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const kept = sorted.slice(0, max).map(([k]) => k);
  const dropped = sorted.slice(max).map(([k]) => k);

  const offset = hasTrans ? 1 : 0; // indice 0 reservado pro transparente
  const lookup = new Map();
  kept.forEach((k, i) => lookup.set(k, i + offset));

  // cores que nao couberam: vizinho mais proximo entre as mantidas
  for (const k of dropped) {
    const r = k >> 16, g = (k >> 8) & 255, b = k & 255;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < kept.length; i++) {
      const kk = kept[i];
      const dr = r - (kk >> 16), dg = g - ((kk >> 8) & 255), db = b - (kk & 255);
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    lookup.set(k, best + offset);
  }

  const palette = hasTrans ? [0, ...kept] : kept;
  return { palette, lookup, transIdx: hasTrans ? 0 : -1 };
}

// LZW do GIF (empacotamento LSB-first, reset de tabela em 4096 codigos).
function lzwEncode(indices, minCodeSize, out) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let table = new Map();

  const bytes = [];
  let cur = 0, curBits = 0;
  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      bytes.push(cur & 0xff);
      cur >>= 8;
      curBits -= 8;
    }
  };

  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const code = table.get(key);
    if (code !== undefined) {
      prefix = code;
    } else {
      emit(prefix);
      if (nextCode === 4096) {
        emit(clearCode);
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
        table = new Map();
      } else {
        if (nextCode >= 1 << codeSize) codeSize++;
        table.set(key, nextCode++);
      }
      prefix = k;
    }
  }
  emit(prefix);
  emit(eoiCode);
  if (curBits > 0) bytes.push(cur & 0xff);

  // sub-blocos de ate 255 bytes
  for (let i = 0; i < bytes.length; i += 255) {
    const n = Math.min(255, bytes.length - i);
    out.push(n, ...bytes.slice(i, i + n));
  }
  out.push(0);
}

export function encodeGif({ width, height, frames, delays = [], loop = 0 }) {
  if (!frames.length) throw new Error('GIF sem frames.');
  const { palette, lookup, transIdx } = buildPalette(frames);

  const palSize = Math.max(2, palette.length);
  const gctExp = Math.max(0, Math.ceil(Math.log2(palSize)) - 1); // gct = 2^(exp+1)
  const gctLen = 1 << (gctExp + 1);
  const minCodeSize = Math.max(2, gctExp + 1);

  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);

  // header + logical screen descriptor
  out.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // "GIF89a"
  u16(width);
  u16(height);
  out.push(0xf0 | gctExp, transIdx >= 0 ? transIdx : 0, 0);

  // global color table
  for (let i = 0; i < gctLen; i++) {
    const c = palette[i] ?? 0;
    out.push((c >> 16) & 255, (c >> 8) & 255, c & 255);
  }

  // NETSCAPE loop extension
  out.push(0x21, 0xff, 0x0b);
  for (const ch of 'NETSCAPE2.0') out.push(ch.charCodeAt(0));
  out.push(0x03, 0x01);
  u16(loop & 0xffff);
  out.push(0x00);

  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    const delay = Math.max(2, Math.round(delays[fi] ?? 10));

    // graphic control extension (disposal=2 p/ transparencia funcionar entre frames)
    out.push(0x21, 0xf9, 0x04, 0x08 | (transIdx >= 0 ? 1 : 0));
    u16(delay);
    out.push(transIdx >= 0 ? transIdx : 0, 0x00);

    // image descriptor
    out.push(0x2c);
    u16(0); u16(0); u16(width); u16(height);
    out.push(0x00);

    const indices = new Uint8Array(width * height);
    for (let p = 0, o = 0; p < indices.length; p++, o += 4) {
      indices[p] =
        f[o + 3] < 128 && transIdx >= 0
          ? transIdx
          : lookup.get((f[o] << 16) | (f[o + 1] << 8) | f[o + 2]) ?? 0;
    }

    out.push(minCodeSize);
    lzwEncode(indices, minCodeSize, out);
  }

  out.push(0x3b); // trailer
  return Buffer.from(out);
}
