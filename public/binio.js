// Envelope binario compartilhado com o servidor:
//   "DMIB" | u32LE tamanho do JSON | JSON (header) | pixels RGBA crus

const MAGIC = [0x44, 0x4d, 0x49, 0x42]; // "DMIB"

// header: objeto JSON; buffers: array de Uint8ClampedArray/Uint8Array
export function encodeEnvelope(header, buffers) {
  const jsonBuf = new TextEncoder().encode(JSON.stringify(header));
  const head = new Uint8Array(8);
  head.set(MAGIC, 0);
  new DataView(head.buffer).setUint32(4, jsonBuf.length, true);
  return new Blob([head, jsonBuf, ...buffers], { type: 'application/octet-stream' });
}

// aceita Response ou ArrayBuffer; retorna { header, body: Uint8ClampedArray }
export async function decodeEnvelope(input) {
  const buf = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  const u8 = new Uint8Array(buf);
  if (u8.length < 8 || MAGIC.some((b, i) => u8[i] !== b)) {
    // pode ser um erro JSON do servidor
    try {
      const err = JSON.parse(new TextDecoder().decode(u8));
      throw new Error(err.error ?? 'Resposta inválida do servidor.');
    } catch (e) {
      throw e instanceof SyntaxError ? new Error('Resposta inválida do servidor.') : e;
    }
  }
  const jsonLen = new DataView(buf).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + jsonLen)));
  return { header, body: new Uint8ClampedArray(buf, 8 + jsonLen) };
}
