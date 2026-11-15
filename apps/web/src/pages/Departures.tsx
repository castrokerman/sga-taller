import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api, errorMessage, formatDate, formatDateTime, formatQty, newOperationKey,
  type Departure, type DepartureInput, type Material, type OpResult, type StockLine, type TreeContainer, type User,
} from '../api';
import { ContentsPhotoPrompt } from '../components/ContentsPhoto';
import { MoveContainersPanel } from '../components/MoveContainers';
import { normalize } from '../components/ListControls';
import { PlaceSelect, type PickedPlace } from '../components/PlaceSelect';
import { MaterialPicker } from '../components/Stock';
import { navigate } from '../router';

type Mode = 'DEFINITIVE' | 'TEMPORARY';

/** Plazos rápidos de una salida temporal, en días. */
const PERIODS: Array<[string, number]> = [
  ['1 día', 1], ['1 semana', 7], ['2 semanas', 14], ['1 mes', 30], ['3 meses', 90],
];

/**
 * Registrar salida: lo que se va del taller, para siempre o por un tiempo, y
 * trasladar un contenedor dentro del taller. Debajo, lo que está fuera ahora.
 */
export function DeparturesPage(props: { user: User; focus?: string }) {
  const { user } = props;
  const [mode, setMode] = useState<Mode | null>(null);
  const [list, setList] = useState<Departure[] | null>(null);
  const [history, setHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canExit = user.permissions.includes('stock.withdraw');

  const load = useCallback(async (all = history) => {
    try {
      setList((await api.departures(all)).departures);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [history]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Registrar salida</h2>
          <p className="muted nomargin">Lo que se va del taller, para siempre o por un tiempo.</p>
        </div>
      </div>
      {error && <p className="alert alert-error">{error}</p>}

      {!mode && (
        <div className="exit-modes">
          {canExit && (
            <button className="exit-mode" onClick={() => setMode('DEFINITIVE')}>
              <span className="exit-icon" aria-hidden="true">📤</span>
              <strong>Salida definitiva</strong>
              <span>Se va del taller para no volver. Queda de baja.</span>
            </button>
          )}
          {canExit && (
            <button className="exit-mode" onClick={() => setMode('TEMPORARY')}>
              <span className="exit-icon" aria-hidden="true">⏳</span>
              <strong>Salida temporal</strong>
              <span>Sale y vuelve: a calibrar, a una obra, a una feria… Eliges cuánto tiempo.</span>
            </button>
          )}
        </div>
      )}

      {(mode === 'DEFINITIVE' || mode === 'TEMPORARY') && (
        <ExitForm
          user={user}
          kind={mode}
          onClose={() => setMode(null)}
          onDone={() => void load()}
        />
      )}

      <section>
        <div className="section-head">
          <h3>{history ? 'Todas las salidas' : 'Fuera del taller ahora'}</h3>
          <label className="check push-right">
            <input
              type="checkbox"
              checked={history}
              onChange={(e) => {
                setHistory(e.target.checked);
                void load(e.target.checked);
              }}
            />
            <span>Ver también las cerradas</span>
          </label>
        </div>
        {list === null ? (
          <p className="muted">Cargando…</p>
        ) : list.length === 0 ? (
          <p className="muted">{history ? 'Aún no hay salidas.' : 'No hay nada fuera del taller.'}</p>
        ) : (
          <div className="exit-list">
            {list.map((d) => (
              <DepartureCard key={d.id} d={d} user={user} focus={props.focus === d.id} onChanged={() => void load()} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

// ---- Una salida en la lista ---------------------------------------------------

function DepartureCard(props: { d: Departure; user: User; focus: boolean; onChanged: () => void }) {
  const { d } = props;
  const [panel, setPanel] = useState<'none' | 'return' | 'extend'>(props.focus && d.status === 'OUT' ? 'return' : 'none');
  const [result, setResult] = useState<OpResult | null>(null);
  const canAct = props.user.permissions.includes('stock.withdraw') && d.status === 'OUT';

  useEffect(() => {
    if (props.focus) document.getElementById(`sal-${d.id}`)?.scrollIntoView({ block: 'center' });
  }, [props.focus, d.id]);

  return (
    <div id={`sal-${d.id}`} className={`card exit-card ${d.overdue ? 'overdue' : ''} ${props.focus ? 'focus' : ''}`}>
      <div className="exit-head">
        <strong className="mono">{d.code}</strong>
        <span className={`tag ${d.kind === 'TEMPORARY' ? 'tag-ctype' : 'tag-inactive'}`}>{d.kind === 'TEMPORARY' ? 'Temporal' : 'Definitiva'}</span>
        {d.status === 'OUT' && (
          <span className={`badge ${d.overdue ? 'badge-warn' : 'badge-ok'}`}>
            {d.overdue ? `Tenía que volver el ${formatDate(d.dueAt)}` : `Vuelve el ${formatDate(d.dueAt)}`}
          </span>
        )}
        {d.status === 'RETURNED' && <span className="badge badge-off">Volvió el {formatDate(d.returnedAt)}</span>}
        {d.status === 'DONE' && <span className="badge badge-off">Salió el {formatDate(d.createdAt)}</span>}
      </div>
      <p className="nomargin">
        {d.containerCode ? (
          <>
            Contenedor <a href={`#/contenedor/${d.containerId}`}><strong className="mono">{d.containerCode}</strong></a>
            {d.containerDescription && ` · ${d.containerDescription}`}
          </>
        ) : (
          d.lines.map((l, i) => (
            <span key={l.materialId + i}>
              {i > 0 && ', '}
              <a href={`#/material/${l.materialId}`}>{l.description}</a>
              {l.quantity !== null && ` (${formatQty(l.quantity, l.unitCode)})`}
            </span>
          ))
        )}{' '}
        → <strong>{d.destination}</strong>
        {d.keptContainerCode && (
          <span className="muted small">
            {' '}· de <a href={`#/contenedor/${d.keptContainerId}`} className="mono">{d.keptContainerCode}</a>, que se quedó en el taller
          </span>
        )}
      </p>
      <p className="muted small nomargin">
        {d.reason && <>{d.reason} · </>}
        Responsable: {d.responsibleName} · registrada por {d.createdByName}, {formatDateTime(d.createdAt)}
        {d.fromCode && <> · estaba en {d.fromCode}</>}
      </p>
      {canAct && panel === 'none' && (
        <div className="row-actions" style={{ marginTop: '0.5rem' }}>
          <button className="btn btn-small btn-primary" onClick={() => setPanel('return')}>
            Ha vuelto
          </button>
          <button className="btn btn-small" onClick={() => setPanel('extend')}>
            Aún no: nuevo plazo
          </button>
        </div>
      )}
      {panel === 'return' && (
        <ReturnForm d={d} onCancel={() => setPanel('none')} onDone={(r) => { setPanel('none'); setResult(r); props.onChanged(); }} />
      )}
      {panel === 'extend' && <ExtendForm d={d} onCancel={() => setPanel('none')} onDone={() => { setPanel('none'); props.onChanged(); }} />}
      {result && (
        <div className="alert alert-ok" style={{ marginTop: '0.5rem' }}>
          <p className="nomargin">{result.message}.</p>
          {result.containers && result.containers.length > 0 && <ContentsPhotoPrompt containers={result.containers} user={props.user} />}
        </div>
      )}
    </div>
  );
}

function ReturnForm(props: { d: Departure; onCancel: () => void; onDone: (r: OpResult) => void }) {
  const { d } = props;
  const [elsewhere, setElsewhere] = useState(false);
  const [place, setPlace] = useState<PickedPlace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(newOperationKey);
  const back = async () => {
    setBusy(true);
    setError(null);
    try {
      props.onDone(await api.returnDeparture(d.id, elsewhere ? place?.ref ?? null : null, key));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const before = d.fromCode ?? d.lines.map((l) => l.fromCode).filter(Boolean)[0] ?? null;
  return (
    <div className="exit-sub">
      <p className="nomargin">
        <strong>¿Ha regresado a las instalaciones de IDOM?</strong> ¿Dónde se guarda?
      </p>
      <label className="check">
        <input type="radio" checked={!elsewhere} onChange={() => setElsewhere(false)} />
        <span>Donde estaba antes{before && <> (<span className="mono">{before}</span>)</>}</span>
      </label>
      <label className="check">
        <input type="radio" checked={elsewhere} onChange={() => setElsewhere(true)} />
        <span>En otro sitio</span>
      </label>
      {elsewhere && (
        <PlaceSelect value={place} onChange={setPlace} moving={Boolean(d.containerId)} hide={d.containerId ? [d.containerId] : undefined} />
      )}
      {error && <p className="alert alert-error">{error}</p>}
      <div className="row-actions">
        <button className="btn btn-small" onClick={props.onCancel} disabled={busy}>
          Cancelar
        </button>
        <button className="btn btn-small btn-primary" onClick={() => void back()} disabled={busy || (elsewhere && !place)}>
          {busy ? 'Guardando…' : 'Registrar la vuelta'}
        </button>
      </div>
    </div>
  );
}

function ExtendForm(props: { d: Departure; onCancel: () => void; onDone: () => void }) {
  const [days, setDays] = useState<number | null>(7);
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.extendDeparture(props.d.id, days ? { days } : { dueDate: date });
      props.onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="exit-sub">
      <p className="nomargin">
        <strong>Aún no ha vuelto.</strong> ¿Cuánto tiempo más va a estar fuera?
      </p>
      <Period days={days} date={date} onDays={setDays} onDate={setDate} />
      {error && <p className="alert alert-error">{error}</p>}
      <div className="row-actions">
        <button className="btn btn-small" onClick={props.onCancel} disabled={busy}>
          Cancelar
        </button>
        <button className="btn btn-small btn-primary" onClick={() => void save()} disabled={busy || (!days && !date)}>
          {busy ? 'Guardando…' : 'Guardar el nuevo plazo'}
        </button>
      </div>
    </div>
  );
}

/** Elegir cuánto tiempo: botones rápidos u otra fecha. */
function Period(props: { days: number | null; date: string; onDays: (d: number | null) => void; onDate: (d: string) => void }) {
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  return (
    <div className="pchips">
      {PERIODS.map(([label, n]) => (
        <button type="button" key={n} className={`pchip ${props.days === n ? 'on' : ''}`} onClick={() => { props.onDays(n); props.onDate(''); }}>
          {label}
        </button>
      ))}
      <button type="button" className={`pchip ${props.days === null ? 'on' : ''}`} onClick={() => props.onDays(null)}>
        Otra fecha
      </button>
      {props.days === null && <input type="date" min={tomorrow} value={props.date} onChange={(e) => props.onDate(e.target.value)} aria-label="Fecha de vuelta" />}
    </div>
  );
}

// ---- Nueva salida ------------------------------------------------------------

interface CartLine {
  line: StockLine;
  quantity: string;
}

function ExitForm(props: { user: User; kind: 'DEFINITIVE' | 'TEMPORARY'; onClose: () => void; onDone: () => void }) {
  const { user, kind } = props;
  const temporary = kind === 'TEMPORARY';
  const [what, setWhat] = useState<'container' | 'content'>('content');
  const [container, setContainer] = useState<TreeContainer | null>(null);
  const [keep, setKeep] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [picking, setPicking] = useState(false);
  const [material, setMaterial] = useState<Material | null>(null);
  const [destination, setDestination] = useState('');
  const [reason, setReason] = useState('');
  const [days, setDays] = useState<number | null>(7);
  const [date, setDate] = useState('');
  const [users, setUsers] = useState<Array<{ id: string; fullName: string }>>([]);
  const [responsible, setResponsible] = useState(user.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ code: string; message: string; containers: Array<{ id: string; code: string }> } | null>(null);
  const [key, setKey] = useState(newOperationKey);

  useEffect(() => {
    api.basicUsers().then((r) => setUsers(r.users)).catch(() => undefined);
  }, []);

  const ready = destination.trim() !== '' && (temporary ? Boolean(days || date) : reason.trim() !== '') &&
    (what === 'container' ? Boolean(container) : cart.length > 0);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const data: DepartureInput = {
      kind, destination: destination.trim(), reason: reason.trim() || undefined,
      ...(temporary ? (days ? { days } : { dueDate: date }) : {}),
      responsibleUserId: responsible,
      ...(what === 'container'
        ? { containerId: container!.id, keepContainer: keep }
        : { lines: cart.map((c) => ({ balanceId: c.line.id, quantity: c.line.quantity === null ? undefined : Number(c.quantity.replace(',', '.')) })) }),
    };
    try {
      setDone(await api.createDeparture(data, key));
      props.onDone();
    } catch (e) {
      setError(errorMessage(e));
      setKey(newOperationKey());
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="card form op-form done-card">
        <h3>Salida registrada: {done.code}</h3>
        <p>{done.message}.</p>
        {done.containers.length > 0 && <ContentsPhotoPrompt containers={done.containers} user={user} />}
        <div className="actions">
          <button className="btn" onClick={props.onClose}>
            Cerrar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card form op-form">
      <h3>{temporary ? '⏳ Salida temporal' : '📤 Salida definitiva'}</h3>

      <div className="field">
        <span className="field-l">1. ¿Qué sale?</span>
        <div className="pchips">
          <button type="button" className={`pchip ${what === 'content' ? 'on' : ''}`} onClick={() => setWhat('content')}>
            Contenido
          </button>
          <button type="button" className={`pchip ${what === 'container' ? 'on' : ''}`} onClick={() => setWhat('container')}>
            Un contenedor
          </button>
        </div>
      </div>

      {what === 'container' ? (
        container ? (
          <p className="confirm">
            <strong className="mono">{container.code}</strong> {container.description && `· ${container.description}`}{keep ? ': sale lo que lleva dentro' : ', con todo lo que lleva dentro'}.{' '}
            <button type="button" className="linkbtn" onClick={() => setContainer(null)}>
              Cambiar
            </button>
          </p>
        ) : (
          <ContainerChooser onPick={setContainer} />
        )
      ) : (
        <>
          {cart.length > 0 && (
            <div className="exit-cart">
              {cart.map((c, i) => (
                <div key={c.line.id} className="exit-cart-row">
                  <span>
                    <strong>{c.line.description}</strong> <span className="muted small">{c.line.internalRef} · en {c.line.placeCode}</span>
                  </span>
                  {c.line.quantity !== null && !c.line.unitTracked ? (
                    <span className="exit-qty">
                      <input
                        value={c.quantity}
                        inputMode="decimal"
                        onChange={(e) => setCart(cart.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                        aria-label="Cantidad"
                      />
                      <span className="muted small">de {formatQty(c.line.quantity, c.line.unitCode)}</span>
                    </span>
                  ) : (
                    <span className="muted small">{c.line.unitTracked ? '1 unidad' : 'sin cantidad'}</span>
                  )}
                  <button type="button" className="linkbtn" onClick={() => setCart(cart.filter((_, j) => j !== i))}>
                    Quitar
                  </button>
                </div>
              ))}
            </div>
          )}
          {material ? (
            <LinePicker
              material={material}
              taken={cart.map((c) => c.line.id)}
              onPick={(line) => {
                setCart([...cart, { line, quantity: line.quantity === null ? '' : String(line.quantity).replace('.', ',') }]);
                setMaterial(null);
              }}
              onCancel={() => setMaterial(null)}
            />
          ) : picking ? (
            <MaterialPicker user={user} onPick={(m) => { setMaterial(m); setPicking(false); }} onCancel={() => setPicking(false)} />
          ) : (
            <button type="button" className="btn" onClick={() => setPicking(true)}>
              {cart.length ? '+ Añadir otro contenido' : '+ Elegir contenido'}
            </button>
          )}
        </>
      )}

      {what === 'container' && container && (
        <div className="field">
          <span className="field-l">¿Y el contenedor?</span>
          <div className="mode-choice">
            <button type="button" className={`mode-card ${!keep ? 'on' : ''}`} onClick={() => setKeep(false)}>
              <b>Se va con lo que lleva</b>
              <span>{temporary ? 'Sale entero y vuelve entero.' : 'Sale entero y queda retirado.'}</span>
            </button>
            <button type="button" className={`mode-card ${keep ? 'on' : ''}`} onClick={() => setKeep(true)}>
              <b>Se queda en el taller para reutilizarlo</b>
              <span>Sale solo lo de dentro; el contenedor queda vacío en su sitio{temporary ? ' y, al volver, lo de dentro regresa a él' : ''}.</span>
            </button>
          </div>
        </div>
      )}

      <label className="field">
        <span className="field-l">2. ¿A dónde va?</span>
        <input value={destination} onChange={(e) => setDestination(e.target.value)} maxLength={200} placeholder="Proveedor, obra, cliente, feria…" />
      </label>

      {temporary ? (
        <div className="field">
          <span className="field-l">3. ¿Cuánto tiempo va a estar fuera?</span>
          <Period days={days} date={date} onDays={setDays} onDate={setDate} />
          <small className="muted">Al acabar el plazo, el responsable recibirá un aviso para indicar si ha regresado a las instalaciones de IDOM.</small>
        </div>
      ) : null}

      <label className="field">
        <span className="field-l">{temporary ? '4. Motivo (opcional)' : '3. Motivo'}</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={temporary ? 'Calibración, reparación, demostración…' : 'Venta, entrega al cliente, desecho…'} />
      </label>

      <label className="field">
        <span className="field-l">{temporary ? '5.' : '4.'} Responsable</span>
        <select value={responsible} onChange={(e) => setResponsible(e.target.value)}>
          {!users.some((u) => u.id === user.id) && <option value={user.id}>{user.fullName}</option>}
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.fullName}
            </option>
          ))}
        </select>
      </label>

      {!temporary && (
        <p className="alert alert-warn nomargin">
          Lo que sale queda de baja: {what === 'container' ? (keep ? 'lo que lleva sale del inventario y el contenedor se queda vacío' : 'el contenedor se retira y lo que lleva sale del inventario') : 'se descuenta del inventario'};
          las herramientas y equipos con su propio código quedan de baja.
        </p>
      )}
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button className="btn" onClick={props.onClose} disabled={busy}>
          Cancelar
        </button>
        <button className="btn btn-primary btn-big-inline" onClick={() => void submit()} disabled={busy || !ready}>
          {busy ? 'Registrando…' : 'Registrar la salida'}
        </button>
      </div>
    </div>
  );
}

/** Dónde está el contenido elegido: se elige de qué sitio sale. */
function LinePicker(props: { material: Material; taken: string[]; onPick: (l: StockLine) => void; onCancel: () => void }) {
  const [lines, setLines] = useState<StockLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.material(props.material.id)
      .then((r) => setLines(r.stock.filter((l) => (l.quantity === null || l.quantity > 0) && !props.taken.includes(l.id))))
      .catch((e) => setError(errorMessage(e)));
  }, [props.material.id, props.taken]);
  return (
    <div className="exit-sub">
      <p className="nomargin">
        <strong>{props.material.description}</strong>: ¿de dónde sale?
      </p>
      {error && <p className="alert alert-error">{error}</p>}
      {lines === null ? (
        <p className="muted">Cargando…</p>
      ) : lines.length === 0 ? (
        <p className="muted">No hay nada de este contenido guardado en el taller.</p>
      ) : (
        <div className="pick">
          {lines.map((l) => (
            <button type="button" key={l.id} className="pick-btn" onClick={() => props.onPick(l)}>
              <span>
                <b className="mono">{l.placeCode}</b>
                <small>{l.locationCode && l.locationCode !== l.placeCode ? `en ${l.locationCode}` : ''}{l.lotCode ? ` · lote ${l.lotCode}` : ''}</small>
              </span>
              <span className="r">{formatQty(l.quantity, l.unitCode, l.quantityTracking)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="row-actions">
        <button type="button" className="btn btn-small" onClick={props.onCancel}>
          Otro contenido
        </button>
      </div>
    </div>
  );
}

/** Buscar un contenedor del taller por código, descripción o lo que lleva dentro. */
function ContainerChooser(props: { onPick: (c: TreeContainer) => void }) {
  const [all, setAll] = useState<TreeContainer[] | null>(null);
  const [locs, setLocs] = useState<Map<string, string>>(new Map());
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.tree()
      .then((r) => {
        setAll(r.containers);
        setLocs(new Map(r.locations.map((l) => [l.id, l.code])));
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const hits = useMemo(() => {
    if (!all) return [];
    const words = normalize(q).split(/\s+/).filter(Boolean);
    return all
      .filter((c) => words.every((w) => normalize([c.code, c.description, c.contentDescription, c.typeName].filter(Boolean).join(' ')).includes(w)))
      .slice(0, 15);
  }, [all, q]);
  const where = (c: TreeContainer) =>
    c.locationId ? locs.get(c.locationId) : all?.find((x) => x.id === c.parentContainerId)?.code;
  return (
    <>
      <label className="field">
        <span>¿Qué contenedor?</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Código, descripción o lo que lleva dentro" autoFocus />
      </label>
      {error && <p className="alert alert-error">{error}</p>}
      {all === null ? (
        <p className="muted">Cargando…</p>
      ) : (
        <div className="pick">
          {hits.map((c) => (
            <button type="button" key={c.id} className="pick-btn" onClick={() => props.onPick(c)}>
              <span>
                <b className="mono">{c.code}</b>
                <small>
                  {[c.typeName, c.description, c.contentDescription && `📦 ${c.contentDescription}`].filter(Boolean).join(' · ')}
                </small>
              </span>
              <span className="r small">{where(c) ?? ''}</span>
            </button>
          ))}
          {hits.length === 0 && <p className="muted">Ningún contenedor coincide.</p>}
        </div>
      )}
    </>
  );
}

/** Mover un contenedor a otro sitio del taller (Día a día → Mover contenedor). */
export function MoveContainerPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h2>Mover contenedor</h2>
          <p className="muted nomargin">Llevarlo a otro sitio dentro del taller, con todo lo que lleva.</p>
        </div>
      </div>
      <MoveInside onClose={() => navigate('inicio')} />
    </>
  );
}

/** Se busca el contenedor y se elige el destino. */
function MoveInside(props: { onClose: () => void }) {
  const [c, setC] = useState<TreeContainer | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (done) {
    return (
      <div className="card form op-form done-card">
        <h3>Contenedor movido</h3>
        <p>{done}.</p>
        <div className="actions">
          <button className="btn" onClick={() => { setDone(null); setC(null); }}>
            Mover otro
          </button>
          <button className="btn" onClick={props.onClose}>
            Cerrar
          </button>
        </div>
      </div>
    );
  }
  if (!c) {
    return (
      <div className="card form op-form">
        <h3>¿Qué contenedor mueves?</h3>
        <ContainerChooser onPick={setC} />
        <div className="actions">
          <button className="btn" onClick={props.onClose}>
            Cancelar
          </button>
        </div>
      </div>
    );
  }
  return (
    <MoveContainersPanel
      containers={[{ id: c.id, code: c.code, typeCode: c.typeCode, hasInside: c.childCount > 0 }]}
      from={c.parentContainerId ?? c.locationId}
      onCancel={() => setC(null)}
      onDone={setDone}
    />
  );
}

export const openDeparture = (id: string) => navigate(`salida/${id}`);
