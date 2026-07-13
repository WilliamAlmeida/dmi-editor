// Leitura/escrita de arquivos .dmi (BYOND).
// Um .dmi é um PNG com um chunk zTXt "Description" contendo a metadata dos icon states.
// Os frames ficam numa grade lida da esquerda p/ direita, de cima p/ baixo, na ordem:
//   para cada state -> para cada frame -> para cada dir   (indice = frame * dirs + dir)
import fs from 'node:fs/promises';
import path from 'node:path';
import { decodePng, encodePng } from './png.js';

const DMI_VERSION = '4.0';

export const DIR_NAMES = ['S', 'N', 'E', 'W', 'SE', 'SW', 'NE', 'NW'];

export function parseMetadata(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '# BEGIN DMI') throw new Error('Metadata DMI ausente ou inválida.');

  const dmi = { version: DMI_VERSION, width: 32, height: 32, states: [] };

  for (const rawLine of lines.slice(1)) {
    const line = rawLine.trim();
    if (line === '# END DMI') break;
    if (!line) continue;

    const sep = line.indexOf(' = ');
    if (sep < 0) continue;
    const key = line.slice(0, sep);
    const value = line.slice(sep + 3);
    const state = dmi.states[dmi.states.length - 1];

    switch (key) {
      case 'version':
        dmi.version = value;
        break;
      case 'width':
        dmi.width = parseInt(value, 10);
        break;
      case 'height':
        dmi.height = parseInt(value, 10);
        break;
      case 'state':
        dmi.states.push({
          name: value.replace(/^"|"$/g, ''),
          dirs: 1,
          frameCount: 1,
          delays: [],
          loop: 0,
          rewind: false,
          movement: false,
          hotspots: [],
          frames: [],
        });
        break;
      case 'dirs':
        if (state) state.dirs = parseInt(value, 10);
        break;
      case 'frames':
        if (state) state.frameCount = parseInt(value, 10);
        break;
      case 'delay':
        if (state) state.delays = value.split(',').map(Number);
        break;
      case 'loop':
        if (state) state.loop = parseInt(value, 10) || 0;
        break;
      case 'rewind':
        if (state) state.rewind = value === '1';
        break;
      case 'movement':
        if (state) state.movement = value === '1';
        break;
      case 'hotspot':
        if (state) state.hotspots.push(value);
        break;
      default:
        break; // chave desconhecida: ignora em vez de quebrar o arquivo
    }
  }

  if (!dmi.width || !dmi.height) throw new Error('Metadata DMI com width/height inválidos.');
  return dmi;
}

export function buildMetadata(dmi) {
  let out = '# BEGIN DMI\n';
  out += `version = ${DMI_VERSION}\n`;
  out += `\twidth = ${dmi.width}\n`;
  out += `\theight = ${dmi.height}\n`;

  for (const s of dmi.states) {
    out += `state = "${s.name}"\n`;
    out += `\tdirs = ${s.dirs}\n`;
    out += `\tframes = ${s.frameCount}\n`;
    if (s.delays?.length && s.frameCount > 1) out += `\tdelay = ${s.delays.slice(0, s.frameCount).join(',')}\n`;
    if (s.loop > 0) out += `\tloop = ${s.loop}\n`;
    if (s.rewind) out += '\trewind = 1\n';
    if (s.movement) out += '\tmovement = 1\n';
    for (const h of s.hotspots ?? []) out += `\thotspot = ${h}\n`;
  }

  out += '# END DMI\n';
  return out;
}

// Recorta um frame (w x h) da spritesheet RGBA.
function cropFrame(sheet, sheetW, x0, y0, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * sheetW + x0) * 4;
    sheet.copy(out, y * w * 4, src, src + w * 4);
  }
  return out;
}

export async function readDmi(file) {
  const png = decodePng(await fs.readFile(file));
  const desc = png.texts.find((t) => t.keyword === 'Description');
  if (!desc) throw new Error('Este PNG não tem metadata DMI (chunk "Description").');

  const dmi = parseMetadata(desc.text);
  dmi.name = path.basename(file, path.extname(file));

  const gridW = Math.floor(png.width / dmi.width);
  if (gridW < 1) throw new Error('Imagem menor que o tamanho de ícone declarado na metadata.');

  let index = 0;
  for (const state of dmi.states) {
    // Normaliza delays: completa com o ultimo valor, corta o excesso, default 1 p/ animações.
    if (state.delays.length) {
      const last = state.delays[state.delays.length - 1];
      while (state.delays.length < state.frameCount) state.delays.push(last);
      state.delays.length = state.frameCount;
    } else if (state.frameCount > 1) {
      state.delays = new Array(state.frameCount).fill(1);
    }

    for (let f = 0; f < state.frameCount; f++) {
      for (let d = 0; d < state.dirs; d++) {
        const x = (index % gridW) * dmi.width;
        const y = Math.floor(index / gridW) * dmi.height;
        if (y + dmi.height > png.height) throw new Error('Spritesheet menor que o esperado pela metadata.');
        state.frames.push(cropFrame(png.data, png.width, x, y, dmi.width, dmi.height));
        index++;
      }
    }
  }

  return dmi;
}

export async function writeDmi(file, dmi) {
  const total = dmi.states.reduce((n, s) => n + s.frames.length, 0);
  const cols = total > 0 ? Math.ceil(Math.sqrt(total)) : 1;
  const rows = total > 0 ? Math.ceil(total / cols) : 1;
  const sheetW = cols * dmi.width;
  const sheetH = rows * dmi.height;
  const sheet = Buffer.alloc(sheetW * sheetH * 4);

  let index = 0;
  for (const state of dmi.states) {
    for (const frame of state.frames) {
      const x0 = (index % cols) * dmi.width;
      const y0 = Math.floor(index / cols) * dmi.height;
      for (let y = 0; y < dmi.height; y++) {
        frame.copy(sheet, ((y0 + y) * sheetW + x0) * 4, y * dmi.width * 4, (y + 1) * dmi.width * 4);
      }
      index++;
    }
  }

  const png = encodePng({
    width: sheetW,
    height: sheetH,
    data: sheet,
    texts: [{ keyword: 'Description', text: buildMetadata(dmi) }],
  });

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, png);
  return { bytes: png.length, sheet: `${sheetW}x${sheetH}`, frames: total };
}
