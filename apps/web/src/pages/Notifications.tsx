import { useEffect, useState } from 'react';
import { api, errorMessage, formatDateTime, type AppNotification } from '../api';
import { navigate } from '../router';

const LINK: Record<AppNotification['entityType'], string> = { location: 'almacen', container: 'contenedor', material: 'contenido', inbound: 'recepcion', movement: 'movimientos', departure: 'salida' };
const KIND: Record<AppNotification['entityType'], string> = { location: 'Ubicación', container: 'Contenedor', material: 'Contenido', inbound: 'Recepción', movement: 'Movimiento', departure: 'Salida' };

/** Avisos recibidos: comentarios en los que alguien pidió avisarte, respuestas y recepciones. */
export function NotificationsPage({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (withRead = all) => {
    try {
      setItems((await api.notifications(withRead)).notifications);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const read = async (n: AppNotification, go: boolean) => {
    try {
      if (!n.readAt) await api.markRead(n.id);
      onChanged();
      if (go) navigate(`${LINK[n.entityType]}/${n.entityId}`);
      else await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const unread = (items ?? []).filter((n) => !n.readAt).length;

  return (
    <>
      <nav className="crumbs">
        <a href="#/inicio">Inicio</a>
        <span>
          <i>›</i>
          <strong>Avisos</strong>
        </span>
      </nav>
      <div className="page-head">
        <div>
          <h2>Avisos</h2>
          <p className="muted nomargin">Comentarios en los que te han avisado, respuestas a tus comentarios y recepciones a tu nombre.</p>
        </div>
        {unread > 0 && (
          <button
            className="btn push-right"
            onClick={async () => {
              await api.markAllRead();
              onChanged();
              await load();
            }}
          >
            Marcar todos como leídos
          </button>
        )}
      </div>
      {error && <p className="alert alert-error">{error}</p>}
      <label className="check">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => {
            setAll(e.target.checked);
            void load(e.target.checked);
          }}
        />
        <span>Ver también los ya leídos</span>
      </label>
      {items === null ? (
        <p className="muted">Cargando…</p>
      ) : items.length === 0 ? (
        <p className="muted">{all ? 'No tienes avisos.' : 'No tienes avisos pendientes.'}</p>
      ) : (
        <ul className="notes notif-list">
          {items.map((n) => (
            <li key={n.id} className={`${n.readAt ? 'read' : 'unread'} ${n.actionNeeded ? 'todo' : ''}`}>
              <div className="note-head">
                <span className="tag">{KIND[n.entityType]}</span>
                <a href={`#/${LINK[n.entityType]}/${n.entityId}`} onClick={(e) => { e.preventDefault(); void read(n, true); }}>
                  <strong>{n.entityCode}</strong> {n.entityName && <span className="muted">· {n.entityName}</span>}
                </a>
              </div>
              <p className="note-body">{n.body}</p>
              {n.actionNeeded && n.kind === 'departure' && (
                <button className="btn btn-primary" onClick={() => { void read(n, false); navigate(`salida/${n.entityId}`); }}>
                  Indicar si ha regresado
                </button>
              )}
              {n.actionNeeded && n.kind !== 'departure' && (
                <button className="btn btn-primary" onClick={() => navigate(`recepcion/${n.entityId}`)}>
                  Completar el registro
                </button>
              )}
              <div className="note-head">
                <span className="muted small">
                  {n.createdBy}{n.isReply ? ' ha respondido' : ''} · {formatDateTime(n.createdAt)}
                </span>
                {!n.readAt ? (
                  <button className="linkbtn small push-right" onClick={() => void read(n, false)}>
                    Marcar como leído
                  </button>
                ) : (
                  <span className="muted small push-right">Leído</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
