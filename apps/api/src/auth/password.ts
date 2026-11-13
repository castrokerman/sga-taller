import { hash, verify } from '@node-rs/argon2';

// Argon2id con los parámetros mínimos recomendados por OWASP.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false; // hash con formato no válido
  }
}

/** Devuelve el motivo por el que la contraseña no es válida, o null si lo es. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`;
  }
  if (password.length > 200) return 'La contraseña es demasiado larga';
  return null;
}
