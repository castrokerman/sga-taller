/** Error con código HTTP y mensaje pensado para mostrarse al usuario. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = (message = 'Debes iniciar sesión') => new AppError(401, 'NO_AUTENTICADO', message);
export const forbidden = (message = 'No tienes permiso para hacer esto') => new AppError(403, 'SIN_PERMISO', message);
export const notFound = (message = 'No encontrado') => new AppError(404, 'NO_ENCONTRADO', message);
export const badRequest = (message: string, code = 'DATOS_NO_VALIDOS') => new AppError(400, code, message);
export const conflict = (message: string, code = 'CONFLICTO') => new AppError(409, code, message);
