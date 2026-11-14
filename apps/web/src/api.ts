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
  /** Parte propia del código; el resto lo pone la ubicación superior. */
  segment: string;
  parentCode: string | null;
  /** Foto principal, si tiene. */
  photoId: string | null;
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
  createdAt: string;
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
  photoId: string | null;
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

/** El árbol trae los mismos datos que las listas, para poder editarlo en tabla. */
export type TreeLocation = LocationSummary;
export type TreeContainer = ContainerSummary;


// ---- Inventario ------------------------------------------------------------

export type Tracking = 'EXACT' | 'ESTIMATED' | 'NOT_TRACKED';

export interface Unit { code: string; name: string; decimals: number }

export interface Family {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  defaultUnitCode: string | null;
  active: boolean;
  path: string;
  ancestorIds: string[];
  materialCount: number;
  childCount: number;
}

export interface Material {
  id: string;
  internalRef: string;
  description: string;
  familyId: string;
  familyName: string;
  manufacturer: string | null;
  manufacturerRef: string | null;
  materialSpec: string | null;
  qualityGrade: string | null;
  dimensions: string | null;
  unitCode: string;
  decimals: number;
  quantityTracking: Tracking;
  lotTracked: boolean;
  isLoanable: boolean;
  minStock: number | null;
  notes: string | null;
  status: 'ACTIVE' | 'OBSOLETE';
  createdAt: string;
  quantity: number | null;
  quantityFree: number;
  places: number;
  needsRecount: boolean;
  lowStock: boolean;
  onLoan: number;
  photoId: string | null;
}

export type MaterialInput = Partial<Omit<Material,
  'id' | 'familyName' | 'decimals' | 'createdAt' | 'quantity' | 'quantityFree' | 'places' | 'needsRecount' | 'lowStock' | 'onLoan'>>;

export interface Allocation { availability: 'FREE' | 'RESTRICTED'; quantity: number; projectCode: string | null; projectName: string | null }

export interface StockLine {
  id: string;
  materialId: string;
  internalRef: string;
  description: string;
  unitCode: string;
  decimals: number;
  quantityTracking: Tracking;
  isLoanable: boolean;
  lotId: string | null;
  lotCode: string | null;
  containerId: string | null;
  locationId: string | null;
  placeCode: string;
  locationCode: string | null;
  quantity: number | null;
  quantityFree: number | null;
  quantityRestricted: number;
  quantityProjectFree: number;
  needsRecount: boolean;
  lastCountedAt: string | null;
  updatedAt: string;
  allocations: Allocation[];
}

export interface MovementLine {
  movementId: string;
  movementNumber: number;
  movementType: string;
  performedAt: string;
  performedBy: string;
  reason: string | null;
  externalReference: string | null;
  reversesNumber: number | null;
  reversedByNumber: number | null;
  lineNo: number;
  materialId: string;
  internalRef: string;
  description: string;
  unitCode: string;
  quantityTracking: Tracking;
  quantityDelta: number | null;
  quantityAfter: number | null;
  lotCode: string | null;
  containerId: string | null;
  locationId: string | null;
  placeCode: string;
}

export interface Loan {
  id: string;
  materialId: string;
  internalRef: string;
  description: string;
  unitCode: string;
  quantity: number;
  borrowerId: string;
  borrowerName: string;
  loanedAt: string;
  dueAt: string;
  returnedAt: string | null;
  status: 'OPEN' | 'RETURNED' | 'LOST';
  notes: string | null;
  overdue: boolean;
  fromCode: string | null;
  containerId: string | null;
  locationId: string | null;
  lotCode: string | null;
}

export interface MaterialDetail {
  material: Material;
  familyPath: string;
  stock: StockLine[];
  movements: MovementLine[];
  loans: Loan[];
}

export interface OpResult {
  movementNumber: number;
  message: string;
  remaining: number | null;
  needsRecount?: boolean;
  emptyDisposable?: string | null;
}

export interface PlaceRef { containerId?: string; locationId?: string }


// ---- Fotos, anotaciones y avisos -----------------------------------------------

export type EntityType = 'location' | 'container' | 'material';

export interface Photo {
  id: string;
  position: number;
  width: number;
  height: number;
  caption: string | null;
  mimeType: string;
  bytes: number;
  uploadedAt: string;
  uploadedById: string;
  uploadedBy: string;
}

export interface Note {
  id: string;
  body: string;
  notify: boolean;
  createdAt: string;
  createdById: string;
  createdBy: string;
  recipients: string[];
}

export interface AppNotification {
  id: string;
  createdAt: string;
  readAt: string | null;
  noteId: string;
  body: string;
  entityType: EntityType;
  entityId: string;
  entityCode: string | null;
  entityName: string | null;
  createdBy: string;
}

export const photoUrl = (id: string, size: 'thumb' | 'image' = 'thumb') => `/api/photos/${id}/${size}`;

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
  createLocation: (data: { segment: string; name: string; typeCode: string; parentId?: string; maxCapacity?: number }) =>
    request<{ location: LocationSummary }>('POST', '/api/locations', data),
  updateLocation: (id: string, data: { segment?: string; name?: string; maxCapacity?: number | null; active?: boolean }) =>
    request<{ location: LocationSummary; descendantsRecoded: number }>('PATCH', `/api/locations/${id}`, data),
  bulkLocations: (items: Array<{ id: string } & Record<string, unknown>>) =>
    request<{ locations: LocationSummary[]; descendantsRecoded: number }>('PATCH', '/api/locations/bulk', { items }),
  recodePreview: () =>
    request<{ changes: Array<{ id: string; code: string; newCode: string; conflictWith: string | null }> }>('GET', '/api/locations/recode-preview'),
  recode: (key: string) => request<{ recoded: number }>('POST', '/api/locations/recode', undefined, key),

  searchContainers: (q: string) =>
    request<{ containers: ContainerSummary[] }>('GET', `/api/containers?q=${encodeURIComponent(q)}`),
  container: (id: string) => request<ContainerDetail>('GET', `/api/containers/${id}`),
  createContainers: (
    data: { typeCode: string; locationId?: string; parentContainerId?: string; quantity: number; description?: string; force?: boolean },
    key: string,
  ) => request<{ containers: ContainerSummary[] }>('POST', '/api/containers', data, key),
  bulkContainers: (items: Array<{ id: string } & Record<string, unknown>>) =>
    request<{ containers: ContainerSummary[] }>('PATCH', '/api/containers/bulk', { items }),
  updateContainer: (id: string, data: { description?: string; reusePolicy?: string; responsibleUserId?: string | null }) =>
    request<ContainerDetail>('PATCH', `/api/containers/${id}`, data),
  moveContainer: (id: string, data: { toLocationId?: string; toParentContainerId?: string; force?: boolean }, key: string) =>
    request<MoveResult>('POST', `/api/containers/${id}/move`, data, key),
  retireContainer: (id: string, reason: string, key: string) =>
    request<ContainerDetail>('POST', `/api/containers/${id}/retire`, { reason }, key),

  locationDuplicateProposal: (id: string) =>
    request<{ code: string; prefix: string | null; segment: string; name: string; descendantCount: number; childrenCopyable: boolean; blockingChildCode: string | null }>(
      'GET', `/api/locations/${id}/duplicate-proposal`,
    ),
  duplicateLocation: (id: string, data: { segment: string; name: string; includeChildren: boolean }, key: string) =>
    request<{ location: LocationSummary; created: number }>('POST', `/api/locations/${id}/duplicate`, data, key),
  duplicateContainer: (id: string, data: { quantity: number; includeChildren: boolean; force?: boolean }, key: string) =>
    request<{ containers: ContainerSummary[] }>('POST', `/api/containers/${id}/duplicate`, data, key),


  units: () => request<{ units: Unit[] }>('GET', '/api/units'),
  families: () => request<{ families: Family[] }>('GET', '/api/material-families'),
  createFamily: (data: { name: string; parentId?: string; defaultUnitCode?: string }) =>
    request<{ family: Family }>('POST', '/api/material-families', data, newOperationKey()),
  updateFamily: (id: string, data: { name?: string; parentId?: string | null; defaultUnitCode?: string | null; active?: boolean }) =>
    request<{ family: Family }>('PATCH', `/api/material-families/${id}`, data),
  deleteFamily: (id: string) => request<{ ok: true }>('DELETE', `/api/material-families/${id}`),

  materials: (includeObsolete = false) =>
    request<{ materials: Material[] }>('GET', `/api/materials?includeObsolete=${includeObsolete}`),
  material: (id: string) => request<MaterialDetail>('GET', `/api/materials/${id}`),
  createMaterial: (data: MaterialInput) => request<{ material: Material }>('POST', '/api/materials', data, newOperationKey()),
  updateMaterial: (id: string, data: MaterialInput) => request<{ material: Material }>('PATCH', `/api/materials/${id}`, data),
  bulkMaterials: (items: Array<{ id: string } & MaterialInput>) =>
    request<{ materials: Material[] }>('PATCH', '/api/materials/bulk', { items }),

  stockAt: (place: PlaceRef) =>
    request<{ stock: StockLine[] }>('GET', `/api/stock?${place.containerId ? `containerId=${place.containerId}` : `locationId=${place.locationId}`}`),
  movements: (limit = 300) => request<{ movements: MovementLine[] }>('GET', `/api/stock/movements?limit=${limit}`),
  receive: (data: PlaceRef & { materialId: string; quantity?: number; lotCode?: string; reason?: string; externalReference?: string; isReturn?: boolean }, key: string) =>
    request<OpResult>('POST', '/api/stock/receipt', data, key),
  withdraw: (data: { balanceId: string; quantity?: number; reason?: string; exhausted?: boolean }, key: string) =>
    request<OpResult>('POST', '/api/stock/withdraw', data, key),
  transfer: (data: { balanceId: string; quantity?: number; toContainerId?: string; toLocationId?: string; reason?: string }, key: string) =>
    request<OpResult>('POST', '/api/stock/transfer', data, key),
  count: (data: { balanceId: string; counted?: number; present?: boolean; reason?: string }, key: string) =>
    request<OpResult>('POST', '/api/stock/count', data, key),
  reverse: (movementId: string, reason: string, key: string) =>
    request<OpResult>('POST', `/api/stock/movements/${movementId}/reverse`, { reason }, key),
  loans: (all = false) => request<{ loans: Loan[] }>('GET', `/api/loans?all=${all}`),
  lend: (data: { balanceId: string; quantity?: number; dueDate?: string; borrowerId?: string; notes?: string }, key: string) =>
    request<OpResult>('POST', '/api/loans', data, key),
  returnLoan: (id: string, data: PlaceRef & { notes?: string }, key: string) =>
    request<OpResult>('POST', `/api/loans/${id}/return`, data, key),


  photos: (entityType: EntityType, entityId: string) =>
    request<{ photos: Photo[] }>('GET', `/api/photos?entityType=${entityType}&entityId=${entityId}`),
  addPhoto: (data: { entityType: EntityType; entityId: string; image: string; thumbnail: string; width: number; height: number }, key: string) =>
    request<{ photo: Photo }>('POST', '/api/photos', data, key),
  makePrimaryPhoto: (id: string) => request<{ ok: true }>('POST', `/api/photos/${id}/primary`, {}),
  deletePhoto: (id: string) => request<{ ok: true }>('DELETE', `/api/photos/${id}`),
  notes: (entityType: EntityType, entityId: string) =>
    request<{ notes: Note[] }>('GET', `/api/notes?entityType=${entityType}&entityId=${entityId}`),
  noteRecipients: (entityType: EntityType, entityId: string) =>
    request<{ suggested: string[]; users: Array<{ id: string; fullName: string; roles: string[] }> }>(
      'GET', `/api/notes/recipients?entityType=${entityType}&entityId=${entityId}`,
    ),
  addNote: (data: { entityType: EntityType; entityId: string; body: string; notify: boolean; recipientIds?: string[] }, key: string) =>
    request<{ note: Note; notified: number }>('POST', '/api/notes', data, key),
  notifications: (all = false) => request<{ notifications: AppNotification[] }>('GET', `/api/notifications?all=${all}`),
  unreadCount: () => request<{ unread: number }>('GET', '/api/notifications/count'),
  markRead: (id: string) => request<{ ok: true }>('POST', `/api/notifications/${id}/read`, {}),
  markAllRead: () => request<{ marked: number }>('POST', '/api/notifications/read-all', {}),

  tree: () => request<{ locations: TreeLocation[]; containers: TreeContainer[] }>('GET', '/api/tree'),
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

/** Cantidad con la unidad, en formato español: «1.250 ud», «6,25 m». */
export const formatQty = (n: number | null | undefined, unit: string, tracking?: Tracking) => {
  if (tracking === 'NOT_TRACKED') return 'Hay';
  if (n === null || n === undefined) return '—';
  const text = `${n.toLocaleString('es-ES', { maximumFractionDigits: 4 })} ${unit}`;
  return tracking === 'ESTIMATED' ? `≈ ${text}` : text;
};

export const TRACKING_NAMES: Record<Tracking, string> = {
  EXACT: 'Exacto',
  ESTIMATED: 'Aproximado',
  NOT_TRACKED: 'Sin contar',
};

export const MOVEMENT_NAMES: Record<string, string> = {
  RECEIPT: 'Entrada',
  WITHDRAWAL: 'Retirada',
  RETURN: 'Devolución',
  TRANSFER: 'Traslado',
  CONTAINER_MOVE: 'Movimiento de contenedor',
  COUNT: 'Recuento',
  ADJUSTMENT: 'Ajuste',
  LOAN_OUT: 'Préstamo',
  LOAN_RETURN: 'Devolución de préstamo',
  REVERSAL: 'Reverso',
};

export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
