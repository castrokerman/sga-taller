/** Cliente de la API. Todas las llamadas pasan por aquí. */

export interface User {
  id: string;
  username: string;
  fullName: string;
  mustChangePassword: boolean;
  roles: string[];
  permissions: string[];
}

export interface AdminUser {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  active: boolean;
  locked: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  roles: string[];
}

export interface Role {
  code: string;
  name: string;
  description: string | null;
  permissions: string[];
}

export interface AuditEntry {
  id: number;
  occurredAt: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  username: string | null;
  fullName: string | null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'x-sga-client': 'web',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'SIN_CONEXION', 'No hay conexión con el servidor. Comprueba la red y vuelve a intentarlo');
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'ERROR',
      data?.error?.message ?? 'Ha ocurrido un error inesperado',
    );
  }
  return data as T;
}

export const api = {
  me: () => request<{ user: User }>('GET', '/api/auth/me'),
  login: (username: string, password: string) =>
    request<{ user: User }>('POST', '/api/auth/login', { username, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('POST', '/api/auth/change-password', { currentPassword, newPassword }),

  roles: () => request<{ roles: Role[] }>('GET', '/api/admin/roles'),
  users: () => request<{ users: AdminUser[] }>('GET', '/api/admin/users'),
  createUser: (data: { username: string; fullName: string; password: string; roles: string[] }) =>
    request<{ user: AdminUser }>('POST', '/api/admin/users', data),
  updateUser: (id: string, data: { fullName?: string; active?: boolean; roles?: string[] }) =>
    request<{ user: AdminUser }>('PATCH', `/api/admin/users/${id}`, data),
  resetPassword: (id: string, newPassword: string) =>
    request<{ ok: true }>('POST', `/api/admin/users/${id}/reset-password`, { newPassword }),
  audit: () => request<{ entries: AuditEntry[] }>('GET', '/api/admin/audit?limit=100'),
};

export const ROLE_NAMES: Record<string, string> = {
  ADMIN_TECNICO: 'Administrador técnico',
  RESP_ALMACEN: 'Responsable de almacén',
  RESP_PROYECTO: 'Responsable de proyecto',
  USUARIO: 'Usuario estándar',
  CONSULTA: 'Usuario de consulta',
};

export const roleName = (code: string) => ROLE_NAMES[code] ?? code;

export const formatDateTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Nunca';
