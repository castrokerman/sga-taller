import { randomBytes } from 'node:crypto';

// Alfabeto sin caracteres que se confunden al leerlos (0/O, 1/I/L, U).
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Token aleatorio e inmutable que va dentro del QR.
 * No contiene ubicación ni contenido: solo identifica, y el servidor dice qué es.
 */
export function newQrToken(): string {
  const bytes = randomBytes(20);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}
