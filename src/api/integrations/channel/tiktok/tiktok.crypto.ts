import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

// LYD-95: cifrado en reposo de los tokens de TikTok. AES-256-GCM; la clave es el SHA-256 de
// TIKTOK_TOKEN_ENCRYPTION_KEY (cualquier string largo sirve). Formato guardado: v1.<iv>.<tag>.<texto cifrado>, en base64url.
const VERSION = 'v1';

function deriveKey(secret: string): Buffer {
  if (!secret) throw new Error('TIKTOK_TOKEN_ENCRYPTION_KEY no esta definida');
  return createHash('sha256').update(secret).digest();
}

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret(payload: string, secret: string): string {
  const [version, iv, tag, encrypted] = payload.split('.');
  if (version !== VERSION || !iv || !tag || !encrypted) throw new Error('Formato de token cifrado invalido');

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}
