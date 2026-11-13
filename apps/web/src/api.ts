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

/** Clave única por operación: si el móvil reenvía la petición, el servidor no la repite. */
export function newOperationKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

async function send(method: string, path: string, body?: unknown, key?: string): Promise<Response> {
  try {
    return await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'x-sga-client': 'web',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'SIN_CONEXION', 'No hay conexión con el servidor. Comprueba la red y vuelve a intentarlo');
  }
}

async function failure(res: Response): Promise<ApiError> {
  const data = await res.json().catch(() => null);
  return new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? 'Ha ocurrido un error inesperado');
}

async function request<T>(method: string, path: string, body?: unknown, key?: string): Promise<T> {
  const res = await send(method, path, body, key);
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

// ---- Almacén ---------------------------------------------------------------

export interface LocationSummary {
  id: string;
  code: string;
  name: string;
  description: string | null;
  parentId: string | null;
  qrToken: string;
  typeCode: string;
  typeName: string;
  maxCapacity: number | null;
  allowedHazardClasses: string[];
  active: boolean;
  childCount: number;
  containerCount: number;
}

export interface ContainerSummary {
  id: string;
  code: string;
  qrToken: string;
  status: 'ACTIVE' | 'RETIRED';
  reusePolicy: 'REUSABLE' | 'DISPOSABLE';
  description: string | null;
  locationId: string | null;
  parentContainerId: string | null;
  responsibleUserId: string | null;
  responsibleName: string | null;
  typeCode: string;
  typeName: string;
  createdAt: string;
  retiredAt: string | null;
  childCount: number;
}

export interface PathItem {
  id: string;
  code: string;
  name?: string;
}

export interface LocationDetail {
  location: LocationSummary;
  path: PathItem[];
  children: LocationSummary[];
  containers: ContainerSummary[];
}

export interface ContainerMovement {
  movementNumber: number;
  movementType: string;
  performedAt: string;
  performedBy: string;
  reason: string | null;
  fromLocation: string | null;
  fromContainer: string | null;
  toLocation: string | null;
  toContainer: string | null;
}

export interface ContainerContent {
  stockBalanceId: string;
  internalRef: string;
  description: string;
  unitCode: string;
  quantityTracking: string;
  lotCode: string | null;
  quantity: number | null;
}

export interface ContainerDetail {
  container: ContainerSummary;
  containerPath: PathItem[];
  locationPath: PathItem[];
  children: ContainerSummary[];
  content: ContainerContent[];
  movements: ContainerMovement[];
}

export interface MoveResult extends ContainerDetail {
  movementNumber: number;
  descendantsMoved: number;
  destination: string;
}

export interface LocationType { code: string; name: string; active: boolean }
export interface ContainerType { code: string; name: string; codePrefix: string; defaultReusePolicy: string; active: boolean }
export interface ScanHit { kind: 'container' | 'location' | 'equipment'; id: string; code: string; name: string | null }
export type LabelFormat = '4x6' | 'a4-24';
export interface LabelRef { kind: 'location' | 'container'; id: string }

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

  locationTypes: () => request<{ types: LocationType[] }>('GET', '/api/location-types'),
  createLocationType: (data: { code: string; name: string }) =>
    request<{ type: LocationType }>('POST', '/api/location-types', data),
  containerTypes: () => request<{ types: ContainerType[] }>('GET', '/api/container-types'),
  createContainerType: (data: { code: string; name: string; codePrefix: string; defaultReusePolicy: string }) =>
    request<{ type: ContainerType }>('POST', '/api/container-types', data),

  rootLocations: () => request<{ locations: LocationSummary[] }>('GET', '/api/locations'),
  location: (id: string) => request<LocationDetail>('GET', `/api/locations/${id}`),
  createLocation: (data: { code: string; name: string; typeCode: string; parentId?: string; maxCapacity?: number }) =>
    request<{ location: LocationSummary }>('POST', '/api/locations', data),
  updateLocation: (id: string, data: { code?: string; name?: string; maxCapacity?: number | null; active?: boolean }) =>
    request<{ location: LocationSummary }>('PATCH', `/api/locations/${id}`, data),

  searchContainers: (q: string) =>
    request<{ containers: ContainerSummary[] }>('GET', `/api/containers?q=${encodeURIComponent(q)}`),
  container: (id: string) => request<ContainerDetail>('GET', `/api/containers/${id}`),
  createContainers: (
    data: { typeCode: string; locationId?: string; parentContainerId?: string; quantity: number; description?: string; force?: boolean },
    key: string,
  ) => request<{ containers: ContainerSummary[] }>('POST', '/api/containers', data, key),
  updateContainer: (id: string, data: { description?: string; reusePolicy?: string; responsibleUserId?: string | null }) =>
    request<ContainerDetail>('PATCH', `/api/containers/${id}`, data),
  moveContainer: (id: string, data: { toLocationId?: string; toParentContainerId?: string; force?: boolean }, key: string) =>
    request<MoveResult>('POST', `/api/containers/${id}/move`, data, key),
  retireContainer: (id: string, reason: string, key: string) =>
    request<ContainerDetail>('POST', `/api/containers/${id}/retire`, { reason }, key),

  locationDuplicateProposal: (id: string) =>
    request<{ code: string; name: string; descendantCount: number; childrenCopyable: boolean; blockingChildCode: string | null }>(
      'GET', `/api/locations/${id}/duplicate-proposal`,
    ),
  duplicateLocation: (id: string, data: { code: string; name: string; includeChildren: boolean }, key: string) =>
    request<{ location: LocationSummary; created: number }>('POST', `/api/locations/${id}/duplicate`, data, key),
  duplicateContainer: (id: string, data: { quantity: number; includeChildren: boolean; force?: boolean }, key: string) =>
    request<{ containers: ContainerSummary[] }>('POST', `/api/containers/${id}/duplicate`, data, key),

  scan: (code: string) => request<ScanHit>('GET', `/api/scan/${encodeURIComponent(code)}`),
  basicUsers: () => request<{ users: Array<{ id: string; fullName: string }> }>('GET', '/api/users/basic'),

  /** Pide el PDF de etiquetas y lo descarga. */
  async downloadLabels(items: LabelRef[], format: LabelFormat): Promise<void> {
    const res = await send('POST', '/api/labels', { items, format });
    if (!res.ok) throw await failure(res);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'etiquetas-sga.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
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

export const errorMessage = (e: unknown) => (e instanceof ApiError ? e.message : 'Ha ocurrido un error inesperado');
