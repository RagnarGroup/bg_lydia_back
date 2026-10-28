// LYD-53: sidecar minimo que implementa el contrato de API_AUDIO_CONVERTER
// que Evolution API ya espera (ver processAudio() en
// src/api/integrations/channel/meta/whatsapp.business.service.ts del fork):
// recibe el audio como multipart `file`, o como campo de texto `url`/`base64`
// dentro del mismo multipart (asi arma el FormData el fork), y lo convierte a
// ogg/opus mono 16kHz -- el unico formato que WhatsApp muestra como nota de
// voz real (burbuja compacta, forma de onda). Un mp3 tambien es reproducible
// para Meta, pero WhatsApp lo renderiza como adjunto de archivo generico (con
// nombre/extension visibles), no como nota de voz -- confirmado en produccion.
// Devuelve { audio: "<base64 ogg/opus>" }. Se escribe a medida en vez de
// asumir una imagen de terceros ya lista, para no depender de un origen no
// verificado.
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { Readable } = require('stream');
const { fixFirstAudioGranule, rewriteOpusTagsVendor } = require('./opus-tags');

ffmpeg.setFfmpegPath(ffmpegPath);

const PORT = process.env.PORT || 4040;
const API_KEY = process.env.API_AUDIO_CONVERTER_KEY || '';

const app = express();
app.use(express.urlencoded({ extended: true }));
// LYD-62: evolution-api manda la nota de voz como campo de texto `base64` del
// multipart, no como `file` -- y multer corta por defecto cualquier campo de
// texto en 1 MB, lo que tumbaba toda nota de voz de mas de ~40 s. WhatsApp
// acepta audio de hasta 16 MB (~21 MB en base64); 25 MB deja margen.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fieldSize: MAX_AUDIO_BYTES, fileSize: MAX_AUDIO_BYTES },
});

function requireApiKey(req, res, next) {
  if (!API_KEY || req.header('apikey') !== API_KEY) {
    return res.status(401).json({ error: 'apikey invalida o ausente' });
  }
  next();
}

async function resolveInputBuffer(req) {
  if (req.file) return req.file.buffer;
  if (req.body.url) {
    const response = await axios.get(req.body.url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
  }
  if (req.body.base64) return Buffer.from(req.body.base64, 'base64');
  throw new Error('Sin audio de entrada: se esperaba file, url o base64');
}

// Mono, 16kHz, libopus -- espec de nota de voz de WhatsApp (Meta solo la
// renderiza como voice note con audio/ogg de codec opus; cualquier otro
// mimetype de audio, aunque reproducible, cae a adjunto de archivo generico).
// LYD-111: sin metadata/capitulos, bitrate de voz (las nativas rondan los
// 18-24 kbps; el default de libopus daba ~78 kbps) y vendor "WhatsApp" en el
// OpusTags -- con el vendor de ffmpeg el movil no la reproduce.
// LYD-130: granule de la primera pagina de audio valido para Android.
function convertToVoiceNote(buffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const output = ffmpeg(Readable.from(buffer))
      .audioCodec('libopus')
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('24k')
      .outputOptions(['-application', 'voip', '-map_metadata', '-1', '-map_chapters', '-1'])
      .toFormat('ogg')
      .on('error', (err) => reject(new Error(`ffmpeg fallo: ${err.message}`)))
      .pipe();
    output.on('data', (chunk) => chunks.push(chunk));
    output.on('end', () => resolve(fixFirstAudioGranule(rewriteOpusTagsVendor(Buffer.concat(chunks)))));
  });
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/process-audio', requireApiKey, upload.single('file'), async (req, res) => {
  try {
    const input = await resolveInputBuffer(req);
    const ogg = await convertToVoiceNote(input);
    res.json({ audio: ogg.toString('base64') });
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : 'Error desconocido' });
  }
});

// Sin esto, un error de multer (limite excedido) sale como 500 HTML generico
// de Express en vez de un JSON que evolution-api pueda loguear.
app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FIELD_VALUE' || err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: `${err.code}: ${err.message}` });
  }
  next(err);
});

app.listen(PORT, () => {
  console.log(`lydia-audio-converter escuchando en :${PORT}`);
});
