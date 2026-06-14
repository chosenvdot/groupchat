import { createHash, randomBytes } from 'node:crypto';

/** Prefixed opaque id, e.g. `iss_4f3a9c21d0b87e55`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/** 32-byte base64url bearer token (agent credentials). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
