/**
 * Propone el siguiente código a partir de uno existente, incrementando el
 * último número que contiene y conservando sus ceros a la izquierda:
 *   ALM-A-P01-E01 → ALM-A-P01-E02      E09 → E10      E99 → E100
 * Si no contiene ningún número, añade «-2».
 */
export function incrementCode(code: string, step = 1): string {
  const match = /(\d+)(?!.*\d)/.exec(code);
  if (!match) return `${code}-${1 + step}`;
  const digits = match[1]!;
  const next = String(Number(digits) + step).padStart(digits.length, '0');
  return code.slice(0, match.index) + next + code.slice(match.index + digits.length);
}

/** Igual que incrementCode, para nombres: «Estantería 1» → «Estantería 2». Si no hay número, añade « (copia)». */
export function incrementName(name: string): string {
  return /\d/.test(name) ? incrementCode(name) : `${name} (copia)`;
}

/**
 * Traslada el código de una ubicación hija al duplicado de su padre:
 * si el original es ALM-A-P01-E01 y la copia ALM-A-P01-E02,
 * la hija ALM-A-P01-E01-N02 pasa a ALM-A-P01-E02-N02.
 * Devuelve null si el código de la hija no empieza por el del original.
 */
export function rebaseCode(childCode: string, fromPrefix: string, toPrefix: string): string | null {
  if (!childCode.startsWith(fromPrefix)) return null;
  return toPrefix + childCode.slice(fromPrefix.length);
}
