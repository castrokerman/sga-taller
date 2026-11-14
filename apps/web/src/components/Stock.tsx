import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  api, ApiError, errorMessage, formatDateTime, formatQty, newOperationKey,
  type Material, type OpResult, type PlaceRef, type ScanHit, type StockLine, type User,
} from '../api';
import { MaterialForm } from '../pages/Materials';
import { navigate } from '../router';
import { normalize } from './ListControls';
import { Scanner } from './Scanner';

/**
 * Material de un sitio (contenedor o ubicación) y todas las operaciones de
 * inventario: entrada, retirada, traslado, recuento y préstamo.
 */

type Op =
  | { kind: 'receipt'; material?: Material }
  | { kind: 'withdraw' | 'transfer' | 'count' | 'lend'; line: StockLine };

export const can = (user: User, p: string) => user.permissions.includes(p);

/** Etiquetas de tipo de stock: genérico, libre o restringido de un proyecto. */
export function StockKind({ line }: { line: Pick<StockLine, 'allocations' | 'quantity' | 'quantityTracking'> }) {
  const restricted = line.allocations.filter((a) => a.availability === 'RESTRICTED');
  const free = line.allocations.filter((a) => a.availability === 'FREE');
  const assigned = line.allocations.reduce((s, a) => s + a.quantity, 0);
  const generic = line.quantityTracking === 'NOT_TRACKED' || line.quantity === null || assigned < line.quantity;
  return (
    <span className="cats">
      {generic && <span className="cat cat-gen">Genérico de taller</span>}
      {free.map((a) => (
        <span key={`f${a.projectCode}`} className="cat cat-libre">Libre · {a.projectCode}</span>
      ))}
      {restricted.map((a) =>
        a.projectCode ? (
          <span key={`r${a.projectCode}`} className="cat cat-rest">Restringido · {a.projectCode}</span>
        ) : (
          <span key="rsp" className="cat cat-rsp">Restringido sin proyecto</span>
        ),
      )}
    </span>
  );
}

export function StockSection(props: { user: User; place: PlaceRef; placeCode: string; active: boolean; onChanged?: () => void }) {
  const { user, place } = props;
  const [lines, setLines] = useState<StockLine[] | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  const [notice, setNotice] = useState<OpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const placeKey = place.containerId ?? place.locationId;

  const load = useCallback(async () => {
    try {
      setLines((await api.stockAt(place)).stock);
    } catch (e) {
      setError(errorMessage(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeKey]);

  useEffect(() => {
    setLines(null);
    setOp(null);
    setNotice(null);
    void load();
  }, [load]);

  const done = async (r: OpResult) => {
    setOp(null);
    await load();
    setNotice(r);
    props.onChanged?.();
  };

  const start = (next: Op) => {
    setNotice(null);
    setError(null);
    setOp(next);
  };

  if (!can(user, 'stock.read')) return null;

  return (
    <section>
      <div className="section-head">
        <h3>Material</h3>
        {props.active && (
          <div className="row-actions">
            {can(user, 'stock.withdraw') && lines && lines.length > 0 && (
              <button className="btn btn-primary" onClick={() => start({ kind: 'withdraw', line: lines[0]! })}>
                Retirar
              </button>
            )}
            {can(user, 'stock.receive') && (
              <button className="btn" onClick={() => start({ kind: 'receipt' })}>
                + Entrada
              </button>
            )}
          </div>
        )}
      </div>

      {notice && <OpNotice r={notice} />}
      {error && <p className="alert alert-error">{error}</p>}

      {op && (
        <OpPanel
          op={op}
          user={user}
          lines={lines ?? []}
          place={place}
          placeCode={props.placeCode}
          onCancel={() => setOp(null)}
          onDone={done}
        />
      )}

      {lines === null ? (
        <p className="muted">Cargando…</p>
      ) : lines.length === 0 ? (
        <p className="muted">No hay material registrado aquí.</p>
      ) : (
        <div className="table-wrap card">
          <table className="stock-table">
            <thead>
              <tr>
                <th>Material</th>
                <th>Tipo de stock</th>
                <th className="num">Cantidad</th>
                {props.active && <th />}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <a href={`#/material/${l.materialId}`}>
                      <strong>{l.description}</strong>
                    </a>
                    <div className="muted small">
                      {l.internalRef}
                      {l.lotCode && ` · lote ${l.lotCode}`}
                    </div>
                  </td>
                  <td>
                    <StockKind line={l} />
                  </td>
                  <td className="num nowrap">
                    <strong>{formatQty(l.quantity, l.unitCode, l.quantityTracking)}</strong>
                    {l.needsRecount && <div><span className="badge badge-warn">Recontar</span></div>}
                  </td>
                  {props.active && (
                    <td>
                      <LineActions user={user} line={l} onOp={start} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function LineActions(props: { user: User; line: StockLine; onOp: (op: Op) => void }) {
  const { user, line } = props;
  return (
    <span className="line-actions">
      {can(user, 'stock.withdraw') && (
        <button className="btn btn-small" onClick={() => props.onOp({ kind: 'withdraw', line })}>
          Retirar
        </button>
      )}
      {can(user, 'stock.transfer') && (
        <button className="btn btn-small" onClick={() => props.onOp({ kind: 'transfer', line })}>
          Trasladar
        </button>
      )}
      {can(user, 'stock.count') && (
        <button className="btn btn-small" onClick={() => props.onOp({ kind: 'count', line })}>
          Recuento
        </button>
      )}
      {line.isLoanable && line.quantityTracking !== 'NOT_TRACKED' && can(user, 'loan.create') && (
        <button className="btn btn-small" onClick={() => props.onOp({ kind: 'lend', line })}>
          Prestar
        </button>
      )}
    </span>
  );
}

export function OpNotice({ r }: { r: OpResult }) {
  return (
    <div className="alert alert-ok">
      <p className="nomargin">
        {r.message}. <span className="muted small">Movimiento n.º {r.movementNumber}</span>
      </p>
      {r.emptyDisposable && (
        <p className="nomargin small" style={{ marginTop: '0.4rem' }}>
          {r.emptyDisposable} es desechable y se ha quedado vacía: si ya no se usa, retírala con el botón «Retirar» de su ficha.
        </p>
      )}
    </div>
  );
}

/** Formulario de la operación elegida. */
export function OpPanel(props: {
  op: Op;
  user: User;
  lines: StockLine[];
  place?: PlaceRef;
  placeCode?: string;
  onCancel: () => void;
  onDone: (r: OpResult) => void;
}) {
  const { op } = props;
  if (op.kind === 'receipt') {
    return <ReceiptForm user={props.user} place={props.place} placeCode={props.placeCode} material={op.material} onCancel={props.onCancel} onDone={props.onDone} />;
  }
  if (op.kind === 'withdraw') {
    return <WithdrawForm user={props.user} lines={props.lines.length ? props.lines : [op.line]} initial={op.line} onCancel={props.onCancel} onDone={props.onDone} />;
  }
  if (op.kind === 'transfer') return <TransferForm line={op.line} onCancel={props.onCancel} onDone={props.onDone} />;
  if (op.kind === 'count') return <CountForm line={op.line} onCancel={props.onCancel} onDone={props.onDone} />;
  return <LendForm user={props.user} line={op.line} onCancel={props.onCancel} onDone={props.onDone} />;
}

/** Ejecuta una operación con su clave única; si falla, se puede reintentar sin duplicarla. */
function useOperation(onDone: (r: OpResult) => void) {
  const [key, setKey] = useState(newOperationKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: (key: string) => Promise<OpResult>) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await fn(key));
    } catch (e) {
      setError(errorMessage(e));
      // Un error de negocio no se ha registrado: la siguiente vez es otra operación.
      if (e instanceof ApiError && e.status !== 0) setKey(newOperationKey());
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

const parseNumber = (s: string) => {
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return s.trim() === '' || !Number.isFinite(n) ? undefined : n;
};

const showNumber = (n: number) => n.toLocaleString('es-ES', { maximumFractionDigits: 4, useGrouping: false });

/** Cantidad con botones grandes de menos y más, cómodos con guantes. */
export function QtyStepper(props: { value: string; onChange: (v: string) => void; decimals: number; unit: string; autoFocus?: boolean }) {
  const step = (d: number) => {
    const n = Math.max(0, (parseNumber(props.value) ?? 0) + d);
    props.onChange(showNumber(n));
  };
  return (
    <div className="stepper">
      <button type="button" onClick={() => step(-1)} aria-label="Menos">−</button>
      <input
        value={props.value}
        inputMode={props.decimals ? 'decimal' : 'numeric'}
        onChange={(e) => props.onChange(e.target.value.replace(props.decimals ? /[^\d,.]/g : /\D/g, ''))}
        onFocus={(e) => e.target.select()}
        autoFocus={props.autoFocus}
        aria-label={`Cantidad en ${props.unit}`}
      />
      <span className="stepper-unit">{props.unit}</span>
      <button type="button" onClick={() => step(1)} aria-label="Más">+</button>
    </div>
  );
}

function Trace({ user, children }: { user: User; children: ReactNode }) {
  return (
    <p className="trace">
      Quedará registrado: <strong>{user.fullName}</strong>, {new Date().toLocaleString('es-ES', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}
      {children}.
    </p>
  );
}

// ---- Retirar -----------------------------------------------------------------

function WithdrawForm(props: { user: User; lines: StockLine[]; initial: StockLine; onCancel: () => void; onDone: (r: OpResult) => void }) {
  const [lineId, setLineId] = useState(props.initial.id);
  const line = props.lines.find((l) => l.id === lineId) ?? props.initial;
  const [qty, setQty] = useState('1');
  const [reason, setReason] = useState('');
  const [exhausted, setExhausted] = useState(false);
  const { busy, error, run } = useOperation(props.onDone);
  const untracked = line.quantityTracking === 'NOT_TRACKED';
  const n = parseNumber(qty);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run((key) => api.withdraw({ balanceId: line.id, quantity: untracked ? undefined : n, reason: reason.trim() || undefined, exhausted: untracked ? exhausted : undefined }, key));
  };

  return (
    <form className="card form op-form" onSubmit={submit}>
      <h3>Retirar material de {line.placeCode}</h3>
      {props.lines.length > 1 && (
        <>
          <span className="field-l">¿Qué te llevas?</span>
          <div className="pick">
            {props.lines.map((l) => (
              <label key={l.id} className={l.id === lineId ? 'on' : undefined}>
                <input type="radio" name="linea" checked={l.id === lineId} onChange={() => setLineId(l.id)} />
                <span>
                  <b>{l.description}</b>
                  <small>
                    {l.internalRef}
                    {l.lotCode && ` · lote ${l.lotCode}`}
                  </small>
                </span>
                <span className="r">{formatQty(l.quantity, l.unitCode, l.quantityTracking)}</span>
              </label>
            ))}
          </div>
        </>
      )}
      {props.lines.length === 1 && (
        <p className="confirm">
          <strong>{line.description}</strong> · hay {formatQty(line.quantity, line.unitCode, line.quantityTracking)}
        </p>
      )}

      {untracked ? (
        <label className="check">
          <input type="checkbox" checked={exhausted} onChange={(e) => setExhausted(e.target.checked)} />
          <span>
            <strong>Se ha acabado</strong>
            <small className="muted"> — ya no queda en este sitio</small>
          </span>
        </label>
      ) : (
        <>
          <span className="field-l">Cantidad</span>
          <QtyStepper value={qty} onChange={setQty} decimals={line.decimals} unit={line.unitCode} />
          {line.quantityTracking === 'ESTIMATED' && <p className="muted small">La cantidad de este material es aproximada.</p>}
        </>
      )}

      <label className="field" style={{ marginTop: '1rem' }}>
        <span>
          ¿Para qué? <span className="muted">(opcional)</span>
        </span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Proyecto, máquina, trabajo…" />
      </label>
      <Trace user={props.user}>
        {untracked ? `, ${line.description}` : n ? `, ${formatQty(n, line.unitCode)}` : ''} de {line.placeCode}
      </Trace>
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary btn-big-inline" disabled={busy || (!untracked && !n)}>
          {busy ? 'Retirando…' : untracked ? 'Retirar' : `Retirar ${n ? formatQty(n, line.unitCode) : ''}`}
        </button>
      </div>
    </form>
  );
}

// ---- Entrada ------------------------------------------------------------------

function ReceiptForm(props: {
  user: User;
  place?: PlaceRef;
  placeCode?: string;
  material?: Material;
  onCancel: () => void;
  onDone: (r: OpResult) => void;
}) {
  const [material, setMaterial] = useState<Material | null>(props.material ?? null);
  const [place, setPlace] = useState<{ ref: PlaceRef; code: string } | null>(
    props.place ? { ref: props.place, code: props.placeCode ?? '' } : null,
  );
  const [qty, setQty] = useState('1');
  const [lot, setLot] = useState('');
  const [albaran, setAlbaran] = useState('');
  const [reason, setReason] = useState('');
  const [isReturn, setIsReturn] = useState(false);
  const { busy, error, run } = useOperation(props.onDone);

  if (!material) {
    return (
      <div className="card form op-form">
        <h3>Entrada{props.placeCode ? ` en ${props.placeCode}` : ''}</h3>
        <MaterialPicker user={props.user} onPick={setMaterial} onCancel={props.onCancel} />
      </div>
    );
  }

  if (!place) {
    return (
      <div className="card form op-form">
        <h3>Entrada de {material.description}</h3>
        <PlacePicker hint="Escanea dónde lo guardas: un contenedor o una ubicación." onPick={setPlace} onCancel={props.onCancel} />
      </div>
    );
  }

  const untracked = material.quantityTracking === 'NOT_TRACKED';
  const n = parseNumber(qty);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run((key) =>
      api.receive(
        {
          ...place.ref, materialId: material.id, quantity: untracked ? undefined : n, lotCode: lot.trim() || undefined,
          externalReference: albaran.trim() || undefined, reason: reason.trim() || undefined, isReturn,
        },
        key,
      ),
    );
  };

  return (
    <form className="card form op-form" onSubmit={submit}>
      <h3>Entrada en {place.code}</h3>
      <p className="confirm">
        <strong>{material.description}</strong> · {material.internalRef}
        {!props.material && (
          <button type="button" className="linkbtn" onClick={() => setMaterial(null)}>
            Cambiar
          </button>
        )}
      </p>
      {untracked ? (
        <p className="muted">Este material no se cuenta: solo se anota que hay en este sitio.</p>
      ) : (
        <>
          <span className="field-l">Cantidad</span>
          <QtyStepper value={qty} onChange={setQty} decimals={material.decimals} unit={material.unitCode} autoFocus />
        </>
      )}
      <div className="grid-2" style={{ marginTop: '1rem' }}>
        <label className="field">
          <span>
            Lote {material.lotTracked ? '' : <span className="muted">(opcional)</span>}
          </span>
          <input value={lot} onChange={(e) => setLot(e.target.value)} maxLength={60} required={material.lotTracked} />
        </label>
        <label className="field">
          <span>
            Albarán o pedido <span className="muted">(opcional)</span>
          </span>
          <input value={albaran} onChange={(e) => setAlbaran(e.target.value)} maxLength={80} />
        </label>
      </div>
      <label className="field">
        <span>
          Nota <span className="muted">(opcional)</span>
        </span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </label>
      {can(props.user, 'stock.return') && (
        <label className="check">
          <input type="checkbox" checked={isReturn} onChange={(e) => setIsReturn(e.target.checked)} />
          <span>
            <strong>Es una devolución</strong>
            <small className="muted"> — material que se sacó y vuelve sin usar</small>
          </span>
        </label>
      )}
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary btn-big-inline" disabled={busy || (!untracked && !n)}>
          {busy ? 'Guardando…' : untracked ? 'Registrar' : `Registrar ${n ? formatQty(n, material.unitCode) : ''}`}
        </button>
      </div>
    </form>
  );
}

/** Buscar un material del catálogo por nombre, referencia o fabricante. Permite crear uno nuevo. */
export function MaterialPicker(props: { user: User; onPick: (m: Material) => void; onCancel: () => void }) {
  const [all, setAll] = useState<Material[] | null>(null);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.materials().then((r) => setAll(r.materials)).catch((e) => setError(errorMessage(e)));
  }, []);

  const hits = useMemo(() => {
    if (!all) return [];
    const words = normalize(q).split(/\s+/).filter(Boolean);
    return all
      .filter((m) => {
        const text = normalize([m.description, m.internalRef, m.manufacturer, m.manufacturerRef, m.familyName, m.dimensions, m.qualityGrade].filter(Boolean).join(' '));
        return words.every((w) => text.includes(w));
      })
      .slice(0, 12);
  }, [all, q]);

  if (creating) {
    return (
      <MaterialForm
        title="Material nuevo"
        onCancel={() => setCreating(false)}
        onDone={(m) => props.onPick(m)}
        embedded
      />
    );
  }

  return (
    <>
      <label className="field">
        <span>¿Qué material?</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Escribe parte del nombre o la referencia" autoFocus />
      </label>
      {error && <p className="alert alert-error">{error}</p>}
      {all === null ? (
        <p className="muted">Cargando catálogo…</p>
      ) : (
        <div className="pick">
          {hits.map((m) => (
            <button type="button" key={m.id} className="pick-btn" onClick={() => props.onPick(m)}>
              <span>
                <b>{m.description}</b>
                <small>
                  {m.internalRef} · {m.familyName}
                </small>
              </span>
              <span className="r">{formatQty(m.quantity, m.unitCode, m.quantityTracking)}</span>
            </button>
          ))}
          {hits.length === 0 && <p className="muted">{all.length === 0 ? 'El catálogo está vacío.' : 'Ningún material coincide.'}</p>}
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        {can(props.user, 'material.manage') && (
          <button type="button" className="btn" onClick={() => setCreating(true)}>
            + Material nuevo
          </button>
        )}
      </div>
    </>
  );
}

/** Elegir un sitio escaneando su QR o tecleando su código. */
export function PlacePicker(props: { hint: string; exclude?: string | null; onPick: (p: { ref: PlaceRef; code: string }) => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onCode = async (code: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const hit: ScanHit = await api.scan(code);
      if (hit.kind === 'equipment') setError('Eso es un equipo. Escanea un contenedor o una ubicación');
      else if (hit.id === props.exclude) setError('Es el mismo sitio en el que ya está');
      else props.onPick({ ref: hit.kind === 'container' ? { containerId: hit.id } : { locationId: hit.id }, code: hit.code });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Scanner onCode={onCode} busy={busy} hint={props.hint} />
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
      </div>
    </>
  );
}

// ---- Trasladar ---------------------------------------------------------------

function TransferForm(props: { line: StockLine; onCancel: () => void; onDone: (r: OpResult) => void }) {
  const { line } = props;
  const [dest, setDest] = useState<{ ref: PlaceRef; code: string } | null>(null);
  const [qty, setQty] = useState(line.quantity !== null ? showNumber(line.quantity) : '');
  const { busy, error, run } = useOperation(props.onDone);
  const untracked = line.quantityTracking === 'NOT_TRACKED';
  const n = parseNumber(qty);

  if (!dest) {
    return (
      <div className="card form op-form">
        <h3>Trasladar {line.description}</h3>
        <PlacePicker
          hint="Escanea el sitio de destino: otro contenedor o una ubicación."
          exclude={line.containerId ?? line.locationId}
          onPick={setDest}
          onCancel={props.onCancel}
        />
      </div>
    );
  }

  return (
    <form
      className="card form op-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run((key) => api.transfer({ balanceId: line.id, quantity: untracked ? undefined : n, toContainerId: dest.ref.containerId, toLocationId: dest.ref.locationId }, key));
      }}
    >
      <h3>Trasladar {line.description}</h3>
      <p className="confirm">
        De <strong>{line.placeCode}</strong> a <strong>{dest.code}</strong>
      </p>
      {!untracked && (
        <>
          <span className="field-l">Cuánto (hay {formatQty(line.quantity, line.unitCode, line.quantityTracking)})</span>
          <QtyStepper value={qty} onChange={setQty} decimals={line.decimals} unit={line.unitCode} />
        </>
      )}
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={() => setDest(null)} disabled={busy}>
          Otro destino
        </button>
        <button className="btn btn-primary btn-big-inline" disabled={busy || (!untracked && !n)}>
          {busy ? 'Trasladando…' : 'Trasladar'}
        </button>
      </div>
    </form>
  );
}

// ---- Recuento ----------------------------------------------------------------

function CountForm(props: { line: StockLine; onCancel: () => void; onDone: (r: OpResult) => void }) {
  const { line } = props;
  const [qty, setQty] = useState('');
  const { busy, error, run } = useOperation(props.onDone);
  const untracked = line.quantityTracking === 'NOT_TRACKED';
  const n = parseNumber(qty);

  return (
    <form
      className="card form op-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run((key) => api.count({ balanceId: line.id, counted: n }, key));
      }}
    >
      <h3>Recuento de {line.description} en {line.placeCode}</h3>
      {untracked ? (
        <>
          <p>¿Sigue habiendo {line.description} en este sitio?</p>
          {error && <p className="alert alert-error">{error}</p>}
          <div className="actions">
            <button type="button" className="btn" onClick={props.onCancel}>
              Cancelar
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => run((key) => api.count({ balanceId: line.id, present: false }, key))}>
              No, ya no hay
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run((key) => api.count({ balanceId: line.id, present: true }, key))}>
              Sí, hay
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            Cuenta lo que hay de verdad y escríbelo. El sistema dice {formatQty(line.quantity, line.unitCode, line.quantityTracking)}
            {line.lastCountedAt && `; último recuento el ${formatDateTime(line.lastCountedAt)}`}.
          </p>
          <span className="field-l">Lo que has contado</span>
          <QtyStepper value={qty} onChange={setQty} decimals={line.decimals} unit={line.unitCode} autoFocus />
          {n !== undefined && line.quantity !== null && n !== line.quantity && (
            <p className="alert alert-warn" style={{ marginTop: '0.8rem' }}>
              Diferencia: {n > line.quantity ? '+' : ''}
              {formatQty(n - line.quantity, line.unitCode)}. Se anotará como ajuste por recuento.
            </p>
          )}
          {error && <p className="alert alert-error">{error}</p>}
          <div className="actions">
            <button type="button" className="btn" onClick={props.onCancel}>
              Cancelar
            </button>
            <button className="btn btn-primary btn-big-inline" disabled={busy || n === undefined}>
              {busy ? 'Guardando…' : 'Guardar recuento'}
            </button>
          </div>
        </>
      )}
    </form>
  );
}

// ---- Prestar -----------------------------------------------------------------

function LendForm(props: { user: User; line: StockLine; onCancel: () => void; onDone: (r: OpResult) => void }) {
  const { line, user } = props;
  const manage = can(user, 'loan.manage');
  const [qty, setQty] = useState('1');
  const [due, setDue] = useState('');
  const [borrower, setBorrower] = useState(user.id);
  const [notes, setNotes] = useState('');
  const [users, setUsers] = useState<Array<{ id: string; fullName: string }>>([]);
  const { busy, error, run } = useOperation(props.onDone);
  const n = parseNumber(qty);
  const defaultDue = new Date(Date.now() + 14 * 86_400_000).toLocaleDateString('es-ES');

  useEffect(() => {
    if (manage) api.basicUsers().then((r) => setUsers(r.users)).catch(() => undefined);
  }, [manage]);

  return (
    <form
      className="card form op-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run((key) => api.lend({ balanceId: line.id, quantity: n, dueDate: due || undefined, borrowerId: borrower, notes: notes.trim() || undefined }, key));
      }}
    >
      <h3>Prestar {line.description}</h3>
      <p className="muted">Sale de {line.placeCode} y queda a nombre de quien se lo lleva hasta que lo devuelva.</p>
      <div className="grid-2">
        <label className="field">
          <span>Para</span>
          {manage ? (
            <select value={borrower} onChange={(e) => setBorrower(e.target.value)}>
              {users.length === 0 && <option value={user.id}>{user.fullName}</option>}
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
            </select>
          ) : (
            <input value={user.fullName} disabled />
          )}
        </label>
        <label className="field">
          <span>Devolver como tarde</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          <small className="muted">Si lo dejas vacío: dentro de 14 días ({defaultDue}).</small>
        </label>
      </div>
      {line.quantity !== null && line.quantity > 1 && (
        <>
          <span className="field-l">Cuántos</span>
          <QtyStepper value={qty} onChange={setQty} decimals={line.decimals} unit={line.unitCode} />
        </>
      )}
      <label className="field" style={{ marginTop: '1rem' }}>
        <span>
          Nota <span className="muted">(opcional)</span>
        </span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
      </label>
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary btn-big-inline" disabled={busy || !n}>
          {busy ? 'Prestando…' : 'Prestar'}
        </button>
      </div>
    </form>
  );
}

export const goMaterial = (id: string) => navigate(`material/${id}`);
