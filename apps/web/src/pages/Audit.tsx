import { useEffect, useState } from 'react';
import { api, ApiError, formatDateTime, type AuditEntry } from '../api';

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
};

export function AuditPage({ back }: { back: () => void }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .audit()
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Ha ocurrido un error inesperado'));
  }, []);

  return (
    <>
      <div className="page-head">
        <button className="btn" onClick={back}>
          ← Inicio
        </button>
        <h2>Auditoría</h2>
      </div>
      <p className="muted">Últimas 100 operaciones registradas. El registro no se puede modificar ni borrar.</p>

      {error && <p className="alert alert-error">{error}</p>}
      {!entries && !error && <p className="muted">Cargando…</p>}

      {entries && (
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Operación</th>
                <th>Usuario</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{formatDateTime(e.occurredAt)}</td>
                  <td>{ACTIONS[e.action] ?? e.action}</td>
                  <td>{e.fullName ?? (e.entityType === 'app_user' && e.entityId ? `(${e.entityId})` : 'Sistema')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
