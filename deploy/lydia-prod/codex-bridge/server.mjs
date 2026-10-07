// LYD-68: puente HTTP minimo entre Lydia (contenedores Docker) y el codex
// headless instalado y logueado en el host del VPS. Corre como unit de systemd
// en el host, no en Docker: el login de ChatGPT vive en ~/.codex del host y los
// contenedores no pueden ejecutar binarios del host.
//
// Contrato: POST /run  {prompt: string}  ->  {text: string}
// Auth: header "Authorization: Bearer <CODEX_BRIDGE_TOKEN>".
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const HOST = process.env.BRIDGE_HOST ?? '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT ?? 3920);
const TOKEN = process.env.CODEX_BRIDGE_TOKEN;
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS ?? 120_000);
const MAX_CONCURRENT = Number(process.env.BRIDGE_MAX_CONCURRENT ?? 2);
const MAX_PROMPT_BYTES = 200_000;
const MODEL = process.env.CODEX_MODEL; // opcional; sin valor usa el de ~/.codex/config.toml

if (!TOKEN) {
  console.error('CODEX_BRIDGE_TOKEN es obligatorio');
  process.exit(1);
}

let running = 0;

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const authorized = (req) => {
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_PROMPT_BYTES) {
        reject(new Error('prompt demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

// Ejecuta `codex exec` en un directorio vacio y de solo lectura: la tarea es
// puramente generar texto, no necesita tocar archivos ni correr comandos.
const runCodex = async (prompt) => {
  const workdir = await mkdtemp(join(tmpdir(), 'codex-bridge-'));
  const outFile = join(workdir, 'last-message.txt');
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-rules',
    '-s',
    'read-only',
    '-C',
    workdir,
    '-o',
    outFile,
    '-',
  ];
  if (MODEL) args.splice(1, 0, '-m', MODEL);

  try {
    await new Promise((resolve, reject) => {
      const child = spawn('codex', args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-2000);
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('codex tardo demasiado'));
      }, TIMEOUT_MS);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`codex salio con codigo ${code}: ${stderr.trim().slice(-500)}`));
      });
      child.stdin.end(prompt);
    });
    return (await readFile(outFile, 'utf8')).trim();
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
};

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/run') return send(res, 404, { error: 'not found' });
  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
  if (running >= MAX_CONCURRENT) return send(res, 429, { error: 'ocupado, reintenta en unos segundos' });

  running += 1;
  try {
    const { prompt } = JSON.parse(await readBody(req));
    if (typeof prompt !== 'string' || !prompt.trim()) return send(res, 400, { error: 'prompt requerido' });
    const text = await runCodex(prompt);
    if (!text) return send(res, 502, { error: 'codex no devolvio texto' });
    return send(res, 200, { text });
  } catch (error) {
    console.error('[codex-bridge]', error instanceof Error ? error.message : error);
    return send(res, 502, { error: error instanceof Error ? error.message : 'error desconocido' });
  } finally {
    running -= 1;
  }
}).listen(PORT, HOST, () => console.log(`codex-bridge escuchando en ${HOST}:${PORT}`));
