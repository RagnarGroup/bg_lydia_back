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

module.exports = { rewriteOpusTagsVendor, oggCrc, readPage };
