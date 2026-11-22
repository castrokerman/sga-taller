import { useEffect, useState } from 'react';
import { api, errorMessage, formatQty, newOperationKey, type ContainerDetail, type StockLine } from '../api';
import { PlaceSelect, type PickedPlace } from './PlaceSelect';
import { Thumb } from './Thumb';

type Action = 'TRASH' | 'MOVE' | 'EXTERNAL';
interface Choice {
  action: Action | null;
  place: PickedPlace | null;
  destination: string;
}
const empty: Choice = { action: null, place: null, destination: '' };

const ACTIONS: Array<[Action, string]> = [
  ['TRASH', '🗑 A la basura'],
  ['MOVE', '🚚 A otro sitio del taller'],
  ['EXTERNAL', '📤 A un sitio externo'],
];

/**
 * Retirar un contenedor. Si lleva cosas, pregunta una por una qué hacer con
 * ella (basura, otro sitio del taller o un sitio externo) y a dónde van los
 * contenedores de dentro. Al confirmar, lo hace todo y lo retira.
 */
export function RetireContainer(props: { detail: ContainerDetail; onCancel: () => void; onDone: (text: string) => void }) {
  const c = props.detail.container;
  const children = props.detail.children.filter((k) => k.status === 'ACTIVE');
  const [lines, setLines] = useState<StockLine[] | null>(null);
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [childTo, setChildTo] = useState<Record<string, PickedPlace | null>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newOperationKey);

  useEffect(() => {
    api.stockAt({ containerId: c.id })
      .then((r) => setLines(r.stock.filter((l) => l.quantity === null || l.quantity > 0)))
      .catch((e) => setError(errorMessage(e)));
  }, [c.id]);

  const get = (id: string) => choice[id] ?? empty;
  const set = (id: string, patch: Partial<Choice>) => setChoice((all) => ({ ...all, [id]: { ...get(id), ...patch } }));
  const allTo = (action: Action) => setChoice(Object.fromEntries((lines ?? []).map((l) => [l.id, { ...get(l.id), action }])));

  const lineReady = (l: StockLine) => {
    const ch = get(l.id);
    return ch.action === 'TRASH' || (ch.action === 'MOVE' && ch.place) || (ch.action === 'EXTERNAL' && ch.destination.trim() !== '');
  };
  const pending = (lines ?? []).filter((l) => !lineReady(l)).length + children.filter((k) => !childTo[k.id]).length;
  const nothingInside = lines !== null && lines.length === 0 && children.length === 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.retireContainerWith(c.id, {
        reason: reason.trim() || undefined,
        items: (lines ?? []).map((l) => {
          const ch = get(l.id);
          return {
            balanceId: l.id, action: ch.action!,
            ...(ch.action === 'MOVE' ? { toContainerId: ch.place!.ref.containerId, toLocationId: ch.place!.ref.locationId } : {}),
            ...(ch.action === 'EXTERNAL' ? { destination: ch.destination.trim() } : {}),
          };
        }),
        children: children.map((k) => ({ containerId: k.id, toContainerId: childTo[k.id]!.ref.containerId, toLocationId: childTo[k.id]!.ref.locationId })),
      }, key);
      const n = (lines?.length ?? 0) + children.length;
      props.onDone(n ? `${c.code} retirado. Lo que llevaba (${n}) ha ido a donde has dicho; queda en el historial.` : `${c.code} retirado. Conserva su historial y su QR.`);
    } catch (e) {
      setError(errorMessage(e));
      setKey(newOperationKey());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form op-form">
      <h3>Retirar {c.code}</h3>
      {lines === null ? (
        <p className="muted">Mirando lo que lleva dentro…</p>
      ) : nothingInside ? (
        <p className="muted">Está vacío: se retira y conserva su historial y su QR.</p>
      ) : (
        <>
          <p className="nomargin">
            Lleva cosas dentro. <strong>¿Qué hacemos con cada una?</strong>
          </p>
          {lines.length > 1 && (
            <div className="retire-all">
              <span className="muted small">Lo mismo para todas:</span>
              {ACTIONS.map(([a, label]) => (
                <button key={a} type="button" className="btn btn-small" onClick={() => allTo(a)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="retire-list">
            {lines.map((l) => {
              const ch = get(l.id);
              return (
                <div key={l.id} className={`retire-item ${lineReady(l) ? 'ready' : ''}`}>
                  <div className="retire-what">
                    <span className="stock-thumb">{l.photoId ? <Thumb photoId={l.photoId} /> : <span aria-hidden="true">📦</span>}</span>
                    <span>
                      <strong>{l.description}</strong>
                      <span className="muted small"> {l.internalRef}{l.quantity !== null && ` · ${formatQty(l.quantity, l.unitCode, l.quantityTracking)}`}</span>
                    </span>
                  </div>
                  <div className="pchips">
                    {ACTIONS.map(([a, label]) => (
                      <button key={a} type="button" className={`pchip ${ch.action === a ? 'on' : ''}`} onClick={() => set(l.id, { action: a })}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {ch.action === 'MOVE' && (
                    <PlaceSelect value={ch.place} onChange={(p) => set(l.id, { place: p })} exclude={c.id} hide={[c.id]} />
                  )}
                  {ch.action === 'EXTERNAL' && (
                    <input
                      value={ch.destination}
                      onChange={(e) => set(l.id, { destination: e.target.value })}
                      maxLength={200}
                      placeholder="¿A dónde va? Proveedor, cliente, obra…"
                      aria-label={`A dónde va ${l.description}`}
                    />
                  )}
                </div>
              );
            })}
            {children.map((k) => (
              <div key={k.id} className={`retire-item ${childTo[k.id] ? 'ready' : ''}`}>
                <div className="retire-what">
                  <span className="stock-thumb"><span aria-hidden="true">▣</span></span>
                  <span>
                    <strong className="mono">{k.code}</strong>
                    <span className="muted small"> {k.typeName}{k.description ? ` · ${k.description}` : ''} · contenedor con lo que lleve</span>
                  </span>
                </div>
                <span className="muted small">¿A qué sitio del taller va?</span>
                <PlaceSelect value={childTo[k.id] ?? null} onChange={(p) => setChildTo({ ...childTo, [k.id]: p })} moving containerType={k.typeCode} exclude={c.id} hide={[c.id]} />
              </div>
            ))}
          </div>
        </>
      )}
      <label className="field">
        <span>
          Motivo de la retirada <span className="muted">(opcional)</span>
        </span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Contenedor roto, ya no se usa…" />
      </label>
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button className="btn" onClick={props.onCancel} disabled={busy}>
          Cancelar
        </button>
        <button className="btn btn-danger btn-big-inline" onClick={() => void submit()} disabled={busy || lines === null || pending > 0}>
          {busy ? 'Retirando…' : pending > 0 ? `Falta decidir ${pending}` : `Retirar ${c.code}`}
        </button>
      </div>
    </div>
  );
}
