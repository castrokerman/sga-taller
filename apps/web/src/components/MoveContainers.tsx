import { useState } from 'react';
import { api, ApiError, errorMessage, newOperationKey, type ScanHit } from '../api';
import { PlaceSelect } from './PlaceSelect';
import { Scanner } from './Scanner';

type Dest = { kind: 'location' | 'container'; id: string; code: string; name?: string | null };

/**
 * Mover uno o varios contenedores: el destino se elige en la lista desplegable
 * (sin saberse el código) o se escanea, y se confirma.
 */
export function MoveContainersPanel(props: {
  containers: Array<{ id: string; code: string; typeCode: string; hasInside?: boolean }>;
  from?: string | null;
  onCancel: () => void;
  onDone: (text: string) => void;
}) {
  const list = props.containers;
  const ids = list.map((x) => x.id);
  const names = list.map((x) => x.code).join(', ');
  const types = [...new Set(list.map((x) => x.typeCode))];
  const [dest, setDest] = useState<Dest | null>(null);
  const [key, setKey] = useState(newOperationKey);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = (d: Dest) => {
    if (ids.includes(d.id)) return setError('Ese es uno de los que vas a mover. Elige el sitio de destino');
    setError(null);
    setWarning(null);
    setKey(newOperationKey());
    setDest(d);
  };

  const onCode = async (code: string) => {
    if (busy || dest) return;
    setBusy(true);
    setError(null);
    try {
      const hit: ScanHit = await api.scan(code);
      if (hit.kind === 'equipment' || hit.kind === 'material') setError(`${hit.code} es un contenido. Escanea una ubicación u otro contenedor`);
      else pick({ kind: hit.kind, id: hit.id, code: hit.code, name: hit.name });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (force: boolean) => {
    if (!dest) return;
    setBusy(true);
    setError(null);
    const moved: string[] = [];
    let inside = 0;
    try {
      for (const [i, c] of list.entries()) {
        const r = await api.moveContainer(
          c.id,
          { ...(dest.kind === 'location' ? { toLocationId: dest.id } : { toParentContainerId: dest.id }), force },
          list.length === 1 ? key : `${key}-${i}`,
        );
        moved.push(c.code);
        inside += r.descendantsMoved;
      }
      const extra = inside > 0 ? `, con ${inside} contenedor${inside > 1 ? 'es' : ''} dentro` : '';
      props.onDone(`${moved.join(', ')} movido${moved.length > 1 ? 's' : ''} a ${dest.code}${extra}`);
    } catch (e) {
      const done = moved.length ? ` (ya movido${moved.length > 1 ? 's' : ''}: ${moved.join(', ')})` : '';
      if (e instanceof ApiError && e.code === 'CAPACIDAD_SUPERADA') {
        setWarning(e.message + done);
        setKey(newOperationKey());
      } else {
        setError(errorMessage(e) + done);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form">
      <h3>Mover {names}</h3>
      {!dest ? (
        <>
          <div className="field">
            <span className="field-l">¿A dónde?</span>
            <PlaceSelect
              value={null}
              moving
              containerType={types.length === 1 ? types[0] : undefined}
              exclude={props.from}
              hide={ids}
              onChange={(p) => p && pick(p.ref.containerId ? { kind: 'container', id: p.ref.containerId, code: p.code } : { kind: 'location', id: p.ref.locationId!, code: p.code })}
            />
            <small className="muted">Una ubicación u otro contenedor. O escanea su etiqueta:</small>
          </div>
          <Scanner onCode={onCode} busy={busy} hint="Escanea el QR del sitio de destino: una ubicación u otro contenedor." />
          {error && <p className="alert alert-error">{error}</p>}
          <div className="actions">
            <button className="btn" onClick={props.onCancel}>
              Cancelar
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="confirm">
            Mover <strong>{names}</strong> {dest.kind === 'location' ? 'a la ubicación' : 'dentro del contenedor'}{' '}
            <strong>{dest.code}</strong>
            {dest.name ? ` (${dest.name})` : ''}
            {list.some((x) => x.hasInside) && ', con todo lo que lleva dentro'}.
          </p>
          {warning && <p className="alert alert-warn">{warning}. Puedes moverlo de todos modos.</p>}
          {error && <p className="alert alert-error">{error}</p>}
          <div className="actions">
            <button className="btn" onClick={() => { setDest(null); setError(null); setWarning(null); }} disabled={busy}>
              Otro destino
            </button>
            <button className="btn btn-primary btn-big-inline" onClick={() => confirm(Boolean(warning))} disabled={busy}>
              {busy ? 'Moviendo…' : warning ? 'Mover de todos modos' : 'Confirmar'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
