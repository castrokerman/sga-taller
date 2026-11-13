import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, forbidden, unauthorized } from '../errors.js';
import type { SessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

/** Exige sesión iniciada. Si el usuario debe cambiar la contraseña, no le deja hacer nada más. */
export function requireAuth(options: { allowPasswordChangePending?: boolean } = {}) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.user) throw unauthorized();
    if (request.user.mustChangePassword && !options.allowPasswordChangePending) {
      throw new AppError(403, 'CAMBIO_DE_CONTRASENA', 'Debes cambiar tu contraseña antes de continuar');
    }
  };
}

/** Exige sesión iniciada y todos los permisos indicados. La comprobación se hace siempre en servidor. */
export function requirePermission(...codes: string[]) {
  const auth = requireAuth();
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await auth(request, reply);
    const have = new Set(request.user!.permissions);
    if (!codes.every((c) => have.has(c))) throw forbidden();
  };
}

export const publicUser = (u: SessionUser) => ({
  id: u.id,
  username: u.username,
  fullName: u.fullName,
  mustChangePassword: u.mustChangePassword,
  roles: u.roles,
  permissions: u.permissions,
});
