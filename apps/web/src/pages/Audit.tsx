import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatDateTime, type AuditEntry } from '../api';

/** Nombre de cada operación registrada. */
const ACTIONS: Record<string, string> = {
  'auth.login': 'Inicio de sesión',
  'auth.logout': 'Cierre de sesión',
  'auth.login_fallido': 'Intento de entrada fallido',
  'auth.login_bloqueado': 'Intento con la cuenta bloqueada',
  'auth.cambio_contrasena': 'Cambio de contraseña',
  'usuario.alta': 'Alta de usuario',
  'usuario.modificacion': 'Modificación de usuario',
  'usuario.restablecer_contrasena': 'Contraseña restablecida',
  'sistema.primer_administrador': 'Creación del primer administrador',
  'sistema.usuarios_de_demostracion': 'Carga de usuarios de demostración',
  'ubicacion.alta': 'Alta de ubicación',
  'ubicacion.modificacion': 'Modificación de ubicación',
  'ubicacion.duplicado': 'Duplicado de ubicación',
  'ubicacion.recodificacion': 'Recodificación de ubicaciones',
  'tipo_ubicacion.alta': 'Alta de tipo de ubicación',
  'tipo_ubicacion.modificacion': 'Modificación de tipo de ubicación',
  'contenedor.alta': 'Alta de contenedor',
  'contenedor.modificacion': 'Modificación de contenedor',
  'contenedor.duplicado': 'Duplicado de contenedor',
  'contenedor.movimiento': 'Movimiento de contenedor',
  'contenedor.retirada': 'Retirada de contenedor',
  'tipo_contenedor.alta': 'Alta de tipo de contenedor',
  'tipo_contenedor.modificacion': 'Modificación de tipo de contenedor',
  'etiquetas.impresion': 'Impresión de etiquetas',
  'exportacion.ubicaciones': 'Exportación de ubicaciones',
  'exportacion.contenedores': 'Exportación de contenedores',
  'exportacion.materiales': 'Exportación de materiales',
  'exportacion.stock': 'Exportación de stock',
  'familia.alta': 'Alta de familia',
  'familia.modificacion': 'Modificación de familia',
  'familia.baja': 'Borrado de familia',
  'material.alta': 'Alta de material',
  'material.modificacion': 'Modificación de material',
  'stock.entrada': 'Entrada de material',
  'stock.devolucion': 'Devolución de material',
  'stock.retirada': 'Retirada de material',
  'stock.traslado': 'Traslado de material',
  'stock.recuento': 'Recuento',
  'stock.reverso': 'Reverso de movimiento',
  'prestamo.salida': 'Préstamo de herramienta',
  'prestamo.devolucion': 'Devolución de préstamo',
  'foto.alta': 'Foto añadida',
  'foto.baja': 'Foto quitada',
  'anotacion.alta': 'Anotación',
  'recepcion.alta': 'Recepción registrada',
  'recepcion.identificada': 'Recepción identificada',
  'recepcion.reasignada': 'Recepción pasada a otra persona',
  'recepcion.anulada': 'Recepción anulada',
  'ubicacion.baja': 'Ubicación eliminada',
};

/** Grupos para filtrar varias operaciones a la vez. */
const GROUPS: Array<[string, string]> = [
  ['auth.', 'Entradas y salidas de la app'],
  ['usuario.', 'Usuarios'],
  ['ubicacion.', 'Ubicaciones'],
  ['contenedor.', 'Contenedores'],
  ['material.', 'Materiales'],
  ['stock.', 'Movimientos de material'],
  ['recepcion.', 'Recepciones'],
  ['prestamo.', 'Préstamos'],
  ['exportacion.', 'Exportaciones a Excel'],
];

const PAGE = 200;

/** Resumen corto de lo registrado: qué cosa y los datos principales. */
function summary(e: AuditEntry): string {
  const data = (e.after ?? e.before ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined || typeof v === 'object' || k === 'password' || k.endsWith('Id') || k === 'id') continue;
    parts.push(`${k}: ${String(v)}`);
    if (parts.length >= 4) break;
  }
  return parts.join(' · ');
}

export function AuditPage({ back }: { back: () => void }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [actions, setActions] = useState<Array<{ action: string; n: number }>>([]);
  const [users, setUsers] = useState<Array<{ id: string; fullName: string }>>([]);
  const [action, setAction] = useState('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.auditActions().then((r) => {
      setActions(r.actions);
      setUsers(r.users);
    }).catch(() => undefined);
  }, []);

  const filters = { action, userId, from, to, q };
  const load = useCallback(
    async (append: boolean, before?: number) => {
      setBusy(true);
      setError(null);
      try {
        const r = await api.audit({ ...filters, limit: PAGE, before });
        setEntries((cur) => (append && cur ? [...cur, ...r.entries] : r.entries));
        setMore(r.more);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [action, userId, from, to, q],
  );

  // Al cambiar un filtro se vuelve a cargar desde el principio (la búsqueda, tras una pausa).
  useEffect(() => {
    const t = window.setTimeout(() => void load(false), q ? 350 : 0);
    return () => window.clearTimeout(t);
  }, [load, q]);

  const active = Boolean(action || userId || from || to || q);
  const groupsPresent = GROUPS.filter(([p]) => actions.some((a) => a.action.startsWith(p)));

  return (
    <>
      <nav className="crumbs">
        <a href="#/inicio" onClick={(e) => { e.preventDefault(); back(); }}>Inicio</a>
        <span>
          <i>›</i>
          <strong>Auditoría</strong>
        </span>
      </nav>
      <div className="page-head">
        <div>
          <h2>Auditoría</h2>
          <p className="muted nomargin">Todo lo que se hace en el sistema, con quién y cuándo. El registro no se puede modificar ni borrar.</p>
        </div>
      </div>

      <div className="card audit-filters">
        <label className="field">
          <span>Operación</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Todas</option>
            {groupsPresent.length > 0 && (
              <optgroup label="Grupos">
                {groupsPresent.map(([p, label]) => (
                  <option key={p} value={p}>
                    {label} (todas)
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Operaciones">
              {[...actions]
                .sort((a, b) => (ACTIONS[a.action] ?? a.action).localeCompare(ACTIONS[b.action] ?? b.action, 'es'))
                .map((a) => (
                  <option key={a.action} value={a.action}>
                    {ACTIONS[a.action] ?? a.action} ({a.n})
                  </option>
                ))}
            </optgroup>
          </select>
        </label>
        <label className="field">
          <span>Usuario</span>
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Todos</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Desde</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span>Hasta</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="field audit-q">
          <span>Contiene</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Código, referencia, nombre…" />
        </label>
        {active && (
          <button
            className="linkbtn"
            onClick={() => { setAction(''); setUserId(''); setFrom(''); setTo(''); setQ(''); }}
          >
            Quitar filtros
          </button>
        )}
      </div>

      {error && <p className="alert alert-error">{error}</p>}
      {!entries && !error && <p className="muted">Cargando…</p>}

      {entries && (
        <>
          <p className="muted small">
            {entries.length === 0 ? 'Ninguna operación cumple los filtros.' : `${entries.length}${more ? ' más recientes' : ''} operaciones${active ? ' con estos filtros' : ''}.`}
          </p>
          {entries.length > 0 && (
            <div className="table-wrap card">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Operación</th>
                    <th>Usuario</th>
                    <th className="hide-m">Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className="clickable" onClick={() => setOpen(open === e.id ? null : e.id)}>
                      <td className="nowrap">{formatDateTime(e.occurredAt)}</td>
                      <td>{ACTIONS[e.action] ?? e.action}</td>
                      <td>{e.fullName ?? (e.entityType === 'app_user' && e.entityId ? `(${e.entityId})` : 'Sistema')}</td>
                      <td className="hide-m audit-detail">
                        {open === e.id ? (
                          <pre>{JSON.stringify({ antes: e.before ?? undefined, despues: e.after ?? undefined }, null, 2)}</pre>
                        ) : (
                          <span className="muted small">{summary(e)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {more && (
            <div className="actions">
              <button className="btn" disabled={busy} onClick={() => load(true, entries[entries.length - 1]!.id)}>
                {busy ? 'Cargando…' : `Cargar ${PAGE} más antiguas`}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
