// LYD-111: WhatsApp movil no reproduce una nota de voz ogg/opus cuyo paquete
// OpusTags trae el vendor de ffmpeg ("Lavf...") -- muestra play y duracion,
// pero no suena (en el navegador y en WhatsApp Web si suena). Las notas de voz
// nativas traen vendor "WhatsApp" y ningun comment. Aca se reemplaza la pagina
// Ogg del OpusTags por una con ese paquete y el CRC recalculado; el resto del
// archivo queda byte a byte igual.
const VENDOR = 'WhatsApp';

// CRC-32 de Ogg: polinomio 0x04c11db7, sin reflejar, init 0, sin xor final.
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  CRC_TABLE[i] = r >>> 0;
}

function oggCrc(buf) {
  let crc = 0;
  for (const byte of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc;
}

function readPage(buf, offset) {
  if (buf.toString('latin1', offset, offset + 4) !== 'OggS') return null;
  const segments = buf[offset + 26];
  const lacing = buf.subarray(offset + 27, offset + 27 + segments);
  const headerLength = 27 + segments;
  const bodyLength = lacing.reduce((sum, v) => sum + v, 0);
  return { offset, headerLength, lacing, length: headerLength + bodyLength };
}

function buildOpusTags() {
  const vendor = Buffer.from(VENDOR, 'utf8');
  const packet = Buffer.alloc(8 + 4 + vendor.length + 4);
  packet.write('OpusTags', 0, 'latin1');
  packet.writeUInt32LE(vendor.length, 8);
  vendor.copy(packet, 12);
  packet.writeUInt32LE(0, 12 + vendor.length); // cero comments
  return packet;
}

// Devuelve el ogg con el OpusTags reescrito, o el mismo buffer si la
// estructura no es la esperada (OpusTags repartido en varias paginas o
// compartiendo pagina): mejor mandar el audio como esta que romperlo.
function rewriteOpusTagsVendor(ogg) {
  const head = readPage(ogg, 0);
  if (!head) return ogg;
  const tags = readPage(ogg, head.length);
  if (!tags) return ogg;

  const bodyStart = tags.offset + tags.headerLength;
  // Un solo paquete completo: todos los segmentos de 255 salvo el ultimo.
  const lastSegment = tags.lacing.length - 1;
  const singlePacket =
    lastSegment >= 0 && tags.lacing[lastSegment] < 255 && tags.lacing.subarray(0, lastSegment).every((v) => v === 255);
  const continued = (ogg[tags.offset + 5] & 0x01) !== 0;
  if (!singlePacket || continued || ogg.toString('latin1', bodyStart, bodyStart + 8) !== 'OpusTags') return ogg;

  const packet = buildOpusTags(); // < 255 bytes: entra en un solo segmento
  const header = Buffer.from(ogg.subarray(tags.offset, tags.offset + 27));
  header[26] = 1;
  const page = Buffer.concat([header, Buffer.from([packet.length]), packet]);
  page.writeUInt32LE(0, 22);
  page.writeUInt32LE(oggCrc(page), 22);

  return Buffer.concat([ogg.subarray(0, tags.offset), page, ogg.subarray(tags.offset + tags.length)]);
}

// Muestras a 48 kHz de un paquete Opus segun su TOC (RFC 6716 §3.1).
function packetSamples(packet) {
  if (!packet.length) return 0;
  const config = packet[0] >> 3;
  let frameSize;
  if (config < 12) frameSize = [480, 960, 1920, 2880][config % 4];
  else if (config < 16) frameSize = [480, 960][config % 2];
  else frameSize = [120, 240, 480, 960][config % 4];
  const code = packet[0] & 0x03;
  if (code === 0) return frameSize;
  if (code !== 3) return frameSize * 2;
  return packet.length > 1 ? frameSize * (packet[1] & 0x3f) : 0;
}

// LYD-130: ffmpeg deja la primera pagina de audio con un granule menor que las
// muestras de sus paquetes (ej. 47976 de 48000). RFC 7845 §4.5 obliga a
// rechazar ese stream, y WhatsApp Android lo rechaza: "algo fallo con el
// archivo de audio". Se suma la diferencia al granule de todas las paginas de
// audio y se recalcula su CRC; los paquetes no cambian. Si la estructura no es
// la esperada, devuelve el mismo buffer.
function fixFirstAudioGranule(ogg) {
  const pages = [];
  for (let offset = 0; offset < ogg.length; ) {
    const page = readPage(ogg, offset);
    if (!page || offset + page.length > ogg.length) return ogg;
    pages.push(page);
    offset += page.length;
  }
  const first = pages[2];
  if (!first) return ogg;

  let samples = 0;
  let packetStart = first.offset + first.headerLength;
  let packetLength = 0;
  for (const value of first.lacing) {
    packetLength += value;
    if (value < 255) {
      samples += packetSamples(ogg.subarray(packetStart, packetStart + packetLength));
      packetStart += packetLength;
      packetLength = 0;
    }
  }
  const delta = BigInt(samples) - ogg.readBigInt64LE(first.offset + 6);
  if (delta <= 0n) return ogg;

  const out = Buffer.from(ogg);
  for (const page of pages.slice(2)) {
    const granule = out.readBigInt64LE(page.offset + 6);
    if (granule === -1n) continue;
    out.writeBigInt64LE(granule + delta, page.offset + 6);
    out.writeUInt32LE(0, page.offset + 22);
    out.writeUInt32LE(oggCrc(out.subarray(page.offset, page.offset + page.length)), page.offset + 22);
  }
  return out;
}

module.exports = { rewriteOpusTagsVendor, fixFirstAudioGranule, oggCrc, readPage };
