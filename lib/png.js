// Codec PNG minimo, sem dependencias (usa apenas zlib do Node).
// Decodifica: color type 0/2/3/4/6, bit depth 1/2/4/8/16, filtros 0-4, tRNS, tEXt/zTXt/iTXt.
// Codifica: sempre RGBA8 (color type 6), filtro None, com chunks de texto zTXt.
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('Arquivo não é um PNG válido.');

  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  const texts = [];
  let off = 8;

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'tEXt') {
      const z = data.indexOf(0);
      texts.push({ keyword: data.toString('latin1', 0, z), text: data.toString('latin1', z + 1) });
    } else if (type === 'zTXt') {
      const z = data.indexOf(0);
      texts.push({
        keyword: data.toString('latin1', 0, z),
        text: zlib.inflateSync(data.subarray(z + 2)).toString('latin1'),
      });
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      const compressed = data[z + 1] === 1;
      const langEnd = data.indexOf(0, z + 3);
      const transEnd = data.indexOf(0, langEnd + 1);
      const raw = data.subarray(transEnd + 1);
      texts.push({
        keyword: data.toString('latin1', 0, z),
        text: (compressed ? zlib.inflateSync(raw) : raw).toString('utf8'),
      });
    } else if (type === 'IEND') break;

    off += 12 + len;
  }

  if (!ihdr) throw new Error('PNG sem cabeçalho IHDR.');
  if (ihdr.interlace) throw new Error('PNG entrelaçado (Adam7) não é suportado.');

  const { width, height, bitDepth, colorType } = ihdr;
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`Color type ${colorType} não suportado.`);

  const bpp = Math.max(1, Math.ceil((bitDepth * channels) / 8));
  const rowBytes = Math.ceil((bitDepth * channels * width) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const lines = Buffer.alloc(rowBytes * height);

  // Desfaz os filtros por scanline.
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[pos++];
    const src = raw.subarray(pos, pos + rowBytes);
    pos += rowBytes;
    const base = y * rowBytes;
    const prev = base - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? lines[base + x - bpp] : 0;
      const b = y > 0 ? lines[prev + x] : 0;
      const c = y > 0 && x >= bpp ? lines[prev + x - bpp] : 0;
      const v = src[x];
      let out;
      if (ft === 0) out = v;
      else if (ft === 1) out = v + a;
      else if (ft === 2) out = v + b;
      else if (ft === 3) out = v + ((a + b) >> 1);
      else if (ft === 4) out = v + paeth(a, b, c);
      else throw new Error(`Filtro PNG desconhecido: ${ft}`);
      lines[base + x] = out & 0xff;
    }
  }

  // Expande qualquer formato para RGBA8.
  const data = Buffer.alloc(width * height * 4);
  const maxVal = (1 << bitDepth) - 1;

  const sample = (rowBase, index) => {
    if (bitDepth === 8) return lines[rowBase + index];
    if (bitDepth === 16) return lines[rowBase + index * 2]; // descarta o byte baixo
    const bitPos = index * bitDepth;
    const byte = lines[rowBase + (bitPos >> 3)];
    const shift = 8 - bitDepth - (bitPos & 7);
    return (byte >> shift) & maxVal;
  };
  const scale = (v) => (bitDepth === 8 || bitDepth === 16 ? v : Math.round((v * 255) / maxVal));

  for (let y = 0; y < height; y++) {
    const rowBase = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const i = x * channels;

      if (colorType === 3) {
        const idx = sample(rowBase, i);
        if (!palette) throw new Error('PNG paletizado sem chunk PLTE.');
        data[o] = palette[idx * 3];
        data[o + 1] = palette[idx * 3 + 1];
        data[o + 2] = palette[idx * 3 + 2];
        data[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const g = sample(rowBase, i);
        const v = scale(g);
        data[o] = data[o + 1] = data[o + 2] = v;
        if (colorType === 4) data[o + 3] = sample(rowBase, i + 1);
        else data[o + 3] = trns && trns.readUInt16BE(0) === g ? 0 : 255;
      } else {
        const r = sample(rowBase, i);
        const g = sample(rowBase, i + 1);
        const b = sample(rowBase, i + 2);
        data[o] = scale(r);
        data[o + 1] = scale(g);
        data[o + 2] = scale(b);
        if (colorType === 6) data[o + 3] = sample(rowBase, i + 3);
        else {
          const t =
            trns && trns.readUInt16BE(0) === r && trns.readUInt16BE(2) === g && trns.readUInt16BE(4) === b;
          data[o + 3] = t ? 0 : 255;
        }
      }
    }
  }

  return { width, height, data, texts };
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// texts: [{ keyword, text }] -> gravados como zTXt (é o que a BYOND lê no DMI).
export function encodePng({ width, height, data, texts = [] }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [SIG, chunk('IHDR', ihdr)];

  for (const { keyword, text } of texts) {
    const kw = Buffer.from(keyword, 'latin1');
    const body = zlib.deflateSync(Buffer.from(text, 'latin1'), { level: 9 });
    parts.push(chunk('zTXt', Buffer.concat([kw, Buffer.from([0, 0]), body])));
  }

  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0; // filtro None
    data.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  parts.push(chunk('IDAT', zlib.deflateSync(raw, { level: 9 })));
  parts.push(chunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(parts);
}
