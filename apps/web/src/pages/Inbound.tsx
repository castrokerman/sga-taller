import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  api, errorMessage, formatDateTime, formatQty, newOperationKey, photoUrl,
  type Disposition, type Family, type Inbound, type InboundStatus, type Material, type PhotoData, type PlaceRef, type Unit, type User,
} from '../api';
import { shrink } from '../components/ItemExtras';
import { parseNumber, PlacePicker, QtyStepper } from '../components/Stock';
import { navigate } from '../router';

type Place = { ref: PlaceRef; code: string };
type Person = { id: string; fullName: string };

const LAST_PLACE = 'sga.recepcion-ultimo-sitio';
const RECENT_PEOPLE = 'sga.recepcion-responsables';
const MAX_PHOTOS = 4;

function readStore<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function writeStore(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sin almacenamiento local */
  }
}

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const STATUS: Record<InboundStatus, { label: string; cls: string }> = {
  PENDING: { label: 'Por identificar', cls: 'badge-warn' },
  DONE: { label: 'Identificada', cls: 'badge-ok' },
  CANCELLED: { label: 'Anulada', cls: 'badge-off' },
};

const daysAgo = (iso: string) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d <= 0 ? 'hoy' : d === 1 ? 'ayer' : `hace ${d} días`;
};

/** Elegir una persona: los últimos usados como botones y la lista completa con búsqueda. */
function PersonPicker(props: { people: Person[] | null; value: string; onChange: (id: string) => void; exclude?: string; recent?: string[] }) {
  const [q, setQ] = useState('');
  const people = (props.people ?? []).filter((p) => p.id !== props.exclude);
  const recent = (props.recent ?? []).map((id) => people.find((p) => p.id === id)).filter(Boolean) as Person[];
  // El elegido siempre se ve como un botón marcado.
  const shownChips = [...recent];
  const picked = people.find((p) => p.id === props.value);
  if (picked && !shownChips.includes(picked)) shownChips.unshift(picked);
  const shown = q ? people.filter((p) => normalize(p.fullName).includes(normalize(q))) : people;
  const chosen = people.find((p) => p.id === props.value);
  return (
    <div className="person-picker">
      {shownChips.length > 0 && (
        <div className="pchips">
          {shownChips.map((p) => (
            <button type="button" key={p.id} className={`pchip ${p.id === props.value ? 'on' : ''}`} onClick={() => props.onChange(p.id)}>
              {p.fullName}
            </button>
          ))}
        </div>
      )}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={chosen ? `Elegido: ${chosen.fullName}. Escribe para buscar otro` : 'Escribe para buscar…'} />
      {(q || !chosen) && (
        <div className="pick pick-short">
          {props.people === null && <p className="muted">Cargando…</p>}
          {shown.slice(0, 8).map((p) => (
            <button
              type="button"
              key={p.id}
              className={`pick-btn ${p.id === props.value ? 'on' : ''}`}
              onClick={() => {
                props.onChange(p.id);
                setQ('');
              }}
            >
              <span><b>{p.fullName}</b></span>
            </button>
          ))}
          {props.people !== null && shown.length === 0 && <p className="muted">Nadie coincide.</p>}
        </div>
      )}
    </div>
  );
}

// ---- Registrar (quien lo recibe) ------------------------------------------------

/**
 * Llega algo que quien lo recibe no sabe identificar: foto, responsable y
 * sitio provisional. El responsable recibe un aviso para completarlo.
 */
export function PendingReceive(props: { user: User; onBack: () => void }) {
  const [photos, setPhotos] = useState<Array<{ file: File; url: string }>>([]);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readStore(RECENT_PEOPLE, []));
  const [responsible, setResponsible] = useState('');
  const [place, setPlace] = useState<Place | null>(null);
  const [picking, setPicking] = useState(false);
  const [last] = useState<Place | null>(() => readStore(LAST_PLACE, null));
  const [description, setDescription] = useState('');
  const [packages, setPackages] = useState('');
  const [albaran, setAlbaran] = useState('');
  const [key, setKey] = useState(newOperationKey);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; code: string; responsible: string; notified: boolean; placeCode: string } | null>(null);
  const camera = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.basicUsers().then((r) => setPeople(r.users)).catch((e) => setError(errorMessage(e)));
  }, []);
  // Las vistas previas se liberan al salir de la pantalla.
  const previews = useRef<string[]>([]);
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const addPhotos = (files: FileList | null) => {
    if (!files) return;
    const more = Array.from(files).slice(0, MAX_PHOTOS - photos.length).map((file) => ({ file, url: URL.createObjectURL(file) }));
    previews.current.push(...more.map((m) => m.url));
    setPhotos((p) => [...p, ...more]);
    if (camera.current) camera.current.value = '';
  };

  const reset = () => {
    setPhotos([]);
    setDescription('');
    setPackages('');
    setAlbaran('');
    setDone(null);
    setKey(newOperationKey());
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!photos.length) return setError('Haz al menos una foto');
    if (!responsible) return setError('Indica quién es el responsable');
    if (!place) return setError('Indica dónde lo dejas');
    try {
      setBusy('Preparando fotos…');
      const data: PhotoData[] = [];
      for (const p of photos) data.push(await shrink(p.file));
      setBusy('Registrando…');
      const n = parseInt(packages, 10);
      const r = await api.createInbound(
        {
          ...place.ref, responsibleUserId: responsible, photos: data, description: description.trim() || undefined,
          packages: n > 0 ? n : undefined, externalReference: albaran.trim() || undefined,
        },
        key,
      );
      const next = [responsible, ...recent.filter((x) => x !== responsible)].slice(0, 4);
      setRecent(next);
      writeStore(RECENT_PEOPLE, next);
      writeStore(LAST_PLACE, place);
      setDone(r);
    } catch (err) {
      setError(errorMessage(err));
      setKey(newOperationKey());
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <div className="card form op-form done-card">
        <h3>Recepción {done.code} registrada</h3>
        <p>
          Queda en <strong className="mono">{done.placeCode}</strong> a la espera de que {done.responsible} indique qué es.
          {done.notified ? ' Ya le ha llegado el aviso.' : ''}
        </p>
        <p className="muted small">Cuando lo identifique te llegará un aviso con lo que hay que hacer.</p>
        <div className="actions actions-wrap">
          <button className="btn btn-primary" onClick={reset}>
            Otra recepción en {done.placeCode}
          </button>
          <a className="btn" href={`#/recepcion/${done.id}`}>
            Ver {done.code}
          </a>
          <a className="btn" href="#/recepciones">
            Ver pendientes
          </a>
        </div>
      </div>
    );
  }

  if (picking) {
    return (
      <div className="card form op-form">
        <h3>¿Dónde lo dejas de momento?</h3>
        <PlacePicker
          hint="Escanea la etiqueta de la ubicación, bandeja o caja donde lo dejas, o escribe su código."
          onPick={(p) => {
            setPlace(p);
            setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      </div>
    );
  }

  return (
    <form className="card form op-form" onSubmit={submit}>
      <h3>Para que lo identifique el responsable</h3>
      <p className="muted nomargin">Haz una foto, di de quién es y dónde lo dejas. Le llegará un aviso para completar el registro.</p>

      <div className="field">
        <span className="field-l">1. Foto</span>
        <div className="shots">
          {photos.map((p, i) => (
            <figure key={p.url} className="shot">
              <img src={p.url} alt={`Foto ${i + 1}`} />
              <button type="button" className="shot-x" aria-label={`Quitar la foto ${i + 1}`} onClick={() => setPhotos((all) => all.filter((x) => x !== p))}>
                ×
              </button>
            </figure>
          ))}
          {photos.length < MAX_PHOTOS && (
            <label className={`shot shot-add ${photos.length ? '' : 'shot-first'}`}>
              <span aria-hidden="true">📷</span>
              <span>{photos.length ? 'Otra foto' : 'Hacer foto'}</span>
              <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => addPhotos(e.target.files)} />
            </label>
          )}
        </div>
        <small className="muted">Que se vea bien la etiqueta o el albarán si lo tiene. Hasta {MAX_PHOTOS} fotos.</small>
      </div>

      <div className="field">
        <span className="field-l">2. ¿De quién es?</span>
        <PersonPicker people={people} value={responsible} onChange={setResponsible} recent={recent} />
      </div>

      <div className="field">
        <span className="field-l">3. ¿Dónde lo dejas de momento?</span>
        {place ? (
          <p className="confirm">
            <strong className="mono">{place.code}</strong>
            <button type="button" className="linkbtn" onClick={() => setPicking(true)}>
              Cambiar
            </button>
          </p>
        ) : (
          <div className="actions actions-wrap nomargin">
            {last && (
              <button type="button" className="btn" onClick={() => setPlace(last)}>
                En el mismo sitio que la última vez: <strong className="mono">{last.code}</strong>
              </button>
            )}
            <button type="button" className="btn" onClick={() => setPicking(true)}>
              📷 Escanear o escribir el sitio
            </button>
          </div>
        )}
      </div>

      <label className="field">
        <span>
          Qué parece o de dónde viene <span className="muted">(opcional)</span>
        </span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Caja de cartón de RS con tres piezas, sobre a nombre de…" />
      </label>
      <div className="grid-2">
        <label className="field">
          <span>
            Bultos <span className="muted">(opcional)</span>
          </span>
          <input value={packages} onChange={(e) => setPackages(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={4} />
        </label>
        <label className="field">
          <span>
            Albarán o pedido <span className="muted">(opcional)</span>
          </span>
          <input value={albaran} onChange={(e) => setAlbaran(e.target.value)} maxLength={80} />
        </label>
      </div>
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onBack} disabled={Boolean(busy)}>
          ← Volver
        </button>
        <button className="btn btn-primary btn-big-inline" disabled={Boolean(busy)}>
          {busy ?? 'Registrar y avisar'}
        </button>
      </div>
    </form>
  );
}

// ---- Lista ----------------------------------------------------------------------

export function InboundListPage({ user }: { user: User }) {
  const manager = user.permissions.includes('inbound.manage');
  const [scope, setScope] = useState<'mine' | 'all'>(manager ? 'all' : 'mine');
  const [status, setStatus] = useState<InboundStatus | 'ALL'>('PENDING');
  const [items, setItems] = useState<Inbound[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    api.inbound(status, scope).then((r) => setItems(r.items)).catch((e) => setError(errorMessage(e)));
  }, [scope, status]);

  const toMe = (items ?? []).filter((i) => i.status === 'PENDING' && i.responsibleId === user.id);

  return (
    <>
      <nav className="crumbs">
        <a href="#/inicio">Inicio</a>
        <span>
          <i>›</i>
          <strong>Recepciones</strong>
        </span>
      </nav>
      <div className="page-head">
        <div>
          <h2>Recepciones por identificar</h2>
          <p className="muted nomargin">Lo que ha llegado y tiene que identificar su responsable.</p>
        </div>
        {user.permissions.includes('stock.receive') && (
          <a className="btn btn-primary push-right" href="#/entrada/pendiente">
            + Nueva recepción
          </a>
        )}
      </div>
      <div className="filters-row">
        {manager && (
          <div className="segbar" role="group" aria-label="De quién">
            <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>Todas</button>
            <button className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>Las mías</button>
          </div>
        )}
        <div className="segbar" role="group" aria-label="Estado">
          {(['PENDING', 'DONE', 'CANCELLED', 'ALL'] as const).map((s) => (
            <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
              {s === 'ALL' ? 'Todas' : s === 'PENDING' ? 'Pendientes' : s === 'DONE' ? 'Identificadas' : 'Anuladas'}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="alert alert-error">{error}</p>}
      {toMe.length > 0 && status === 'PENDING' && (
        <p className="alert alert-warn">
          Tienes {toMe.length === 1 ? 'una recepción' : `${toMe.length} recepciones`} por identificar.
        </p>
      )}
      {items === null ? (
        <p className="muted">Cargando…</p>
      ) : items.length === 0 ? (
        <p className="muted">{status === 'PENDING' ? 'No hay nada pendiente de identificar.' : 'No hay recepciones.'}</p>
      ) : (
        <div className="list">
          {items.map((i) => (
            <InboundCard key={i.id} i={i} mine={i.responsibleId === user.id} />
          ))}
        </div>
      )}
    </>
  );
}

function InboundCard({ i, mine }: { i: Inbound; mine: boolean }) {
  return (
    <button className={`item inbound-item ${i.status === 'PENDING' && mine ? 'item-todo' : ''}`} onClick={() => navigate(`recepcion/${i.id}`)}>
      {i.photoId ? <img className="item-photo" src={photoUrl(i.photoId)} alt="" loading="lazy" /> : <span className="item-photo" />}
      <span className="item-main">
        <strong>
          {i.status === 'DONE' ? i.materialDescription : i.description || 'Sin descripción'}
        </strong>
        <span>
          <span className="mono">{i.code}</span> · para {i.responsible} · 📍 {i.status === 'DONE' && i.finalPlaceCode ? i.finalPlaceCode : i.placeCode}
        </span>
        <small className="muted">
          Recibido por {i.receivedBy} {daysAgo(i.receivedAt)}
        </small>
      </span>
      <span className="item-meta">
        <span className={`badge ${STATUS[i.status].cls}`}>{STATUS[i.status].label}</span>
        {i.status === 'PENDING' && mine && <span className="small strong">Te toca</span>}
      </span>
    </button>
  );
}

// ---- Ficha y formulario del responsable ----------------------------------------

export function InboundPage({ user, inboundId, onChanged }: { user: User; inboundId: string; onChanged: () => void }) {
  const [data, setData] = useState<{ item: Inbound; canComplete: boolean; canCancel: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'reassign' | 'cancel'>('view');
  const [message, setMessage] = useState<string | null>(null);
  const [big, setBig] = useState<string | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);

  const load = async () => {
    try {
      const d = await api.inboundItem(inboundId);
      setData(d);
      setPhotos((await api.photos('inbound', inboundId)).photos.map((p) => p.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    setData(null);
    setMessage(null);
    setMode('view');
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboundId]);

  const crumbs = (
    <nav className="crumbs">
      <a href="#/inicio">Inicio</a>
      <span>
        <i>›</i>
        <a href="#/recepciones">Recepciones</a>
      </span>
      <span>
        <i>›</i>
        <strong>{data?.item.code ?? '…'}</strong>
      </span>
    </nav>
  );
  if (error && !data) return (<>{crumbs}<p className="alert alert-error">{error}</p></>);
  if (!data) return (<>{crumbs}<p className="muted">Cargando…</p></>);
  const { item: i } = data;

  return (
    <>
      {crumbs}
      <div className="page-head">
        <div>
          <h2>
            Recepción <span className="mono">{i.code}</span> <span className={`badge ${STATUS[i.status].cls}`}>{STATUS[i.status].label}</span>
          </h2>
          <p className="muted nomargin">
            Recibida por {i.receivedBy} el {formatDateTime(i.receivedAt)} · para {i.responsible}
          </p>
        </div>
      </div>
      {message && <p className="alert alert-ok">{message}</p>}

      <div className="inbound-head card">
        <div className="shots shots-big">
          {photos.map((id) => (
            <button key={id} className="shot" onClick={() => setBig(id)} aria-label="Ver la foto en grande">
              <img src={photoUrl(id)} alt="" />
            </button>
          ))}
        </div>
        <dl className="facts">
          {i.description && (<><dt>Al recibirlo</dt><dd>{i.description}</dd></>)}
          <dt>Dónde está</dt>
          <dd>
            <a className="mono" href={i.containerId ? `#/contenedor/${i.containerId}` : `#/almacen/${i.locationId}`}>{i.placeCode}</a>
            {i.status !== 'PENDING' || ' (provisional)'}
          </dd>
          {i.packages && (<><dt>Bultos</dt><dd>{i.packages}</dd></>)}
          {i.externalReference && (<><dt>Albarán</dt><dd>{i.externalReference}</dd></>)}
        </dl>
      </div>
      {big && (
        <div className="photo-viewer" role="dialog" onClick={() => setBig(null)}>
          <img src={photoUrl(big, 'image')} alt="" />
        </div>
      )}

      {i.status === 'DONE' && (
        <div className="card">
          <h3>Identificada por {i.completedBy}</h3>
          <dl className="facts">
            <dt>Qué es</dt>
            <dd>
              <a href={`#/material/${i.materialId}`}>{i.materialDescription}</a> <span className="muted">· {i.materialRef}</span>
            </dd>
            {i.quantity !== null && (<><dt>Cantidad</dt><dd>{formatQty(i.quantity, i.unitCode ?? '')}</dd></>)}
            {i.lotCode && (<><dt>Lote</dt><dd>{i.lotCode}</dd></>)}
            {i.projectRef && (<><dt>Proyecto</dt><dd>{i.projectRef}</dd></>)}
            {i.usagePlace && (<><dt>Dónde se usa</dt><dd>{i.usagePlace}</dd></>)}
            <dt>Qué se hace</dt>
            <dd>
              {i.disposition === 'DEPLOY' ? (
                'Se despliega directamente, no se guarda'
              ) : (
                <>
                  Se guarda en{' '}
                  <a className="mono" href={i.finalContainerId ? `#/contenedor/${i.finalContainerId}` : `#/almacen/${i.finalLocationId}`}>
                    {i.finalPlaceCode}
                  </a>
                </>
              )}
            </dd>
            {i.completionNote && (<><dt>Nota</dt><dd>{i.completionNote}</dd></>)}
            <dt>Cuándo</dt>
            <dd>{formatDateTime(i.completedAt)}</dd>
          </dl>
        </div>
      )}
      {i.status === 'CANCELLED' && (
        <p className="alert alert-warn">
          Anulada por {i.cancelledBy} el {formatDateTime(i.cancelledAt)}: {i.cancelReason}
        </p>
      )}

      {i.status === 'PENDING' && mode === 'view' && (
        <>
          {data.canComplete ? (
            <CompleteForm
              user={user}
              item={i}
              onDone={async (msg) => {
                setMessage(msg);
                onChanged();
                await load();
                window.scrollTo(0, 0);
              }}
            />
          ) : (
            <p className="alert alert-warn">Pendiente de que {i.responsible} indique qué es.</p>
          )}
          <div className="actions actions-wrap">
            <button className="btn" onClick={() => setMode('reassign')}>
              {i.responsibleId === user.id ? 'No es mío: pasárselo a otra persona' : 'Cambiar el responsable'}
            </button>
            {data.canCancel && (
              <button className="btn btn-danger" onClick={() => setMode('cancel')}>
                Anular
              </button>
            )}
          </div>
        </>
      )}
      {i.status === 'PENDING' && mode === 'reassign' && (
        <ReassignForm
          item={i}
          onCancel={() => setMode('view')}
          onDone={async (name) => {
            setMessage(`Ahora es responsabilidad de ${name}. Ya le ha llegado el aviso.`);
            setMode('view');
            onChanged();
            await load().catch(() => undefined);
          }}
          onGone={(name) => {
            onChanged();
            void name;
            navigate('recepciones');
          }}
          me={user.id}
          manager={user.permissions.includes('inbound.manage')}
        />
      )}
      {i.status === 'PENDING' && mode === 'cancel' && (
        <CancelForm
          item={i}
          onCancel={() => setMode('view')}
          onDone={async () => {
            setMode('view');
            setMessage('Recepción anulada.');
            onChanged();
            await load();
          }}
        />
      )}
    </>
  );
}

function CompleteForm(props: { user: User; item: Inbound; onDone: (message: string) => void }) {
  const { item } = props;
  const [all, setAll] = useState<Material[] | null>(null);
  const [families, setFamilies] = useState<Family[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [material, setMaterial] = useState<Material | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [nm, setNm] = useState({ description: item.description ?? '', familyId: '', unitCode: 'ud', manufacturer: '', manufacturerRef: '' });
  const [qty, setQty] = useState('1');
  const [lot, setLot] = useState('');
  const [project, setProject] = useState('');
  const [usage, setUsage] = useState('');
  const [disposition, setDisposition] = useState<Disposition | null>(null);
  const [dest, setDest] = useState<Place | null>(null);
  const [picking, setPicking] = useState(false);
  const [usePhoto, setUsePhoto] = useState(true);
  const [note, setNote] = useState('');
  const [key, setKey] = useState(newOperationKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.materials().then((r) => setAll(r.materials)).catch((e) => setError(errorMessage(e)));
    api.families().then((r) => setFamilies(r.families.filter((f) => f.active))).catch(() => undefined);
    api.units().then((r) => setUnits(r.units)).catch(() => undefined);
    api.inboundProjects().then((r) => setProjects(r.projects)).catch(() => undefined);
  }, []);

  const hits = useMemo(() => {
    if (!all || !q.trim()) return [];
    const words = normalize(q).split(/\s+/).filter(Boolean);
    return all
      .filter((m) => m.status === 'ACTIVE')
      .filter((m) => {
        const t = normalize([m.description, m.internalRef, m.manufacturer, m.manufacturerRef, m.familyName].filter(Boolean).join(' '));
        return words.every((w) => t.includes(w));
      })
      .slice(0, 8);
  }, [all, q]);

  const decimals = isNew ? (units.find((u) => u.code === nm.unitCode)?.decimals ?? 0) : (material?.decimals ?? 0);
  const unit = isNew ? nm.unitCode : (material?.unitCode ?? 'ud');
  const untracked = !isNew && material?.quantityTracking === 'NOT_TRACKED';
  const lotRequired = !isNew && Boolean(material?.lotTracked);
  const n = parseNumber(qty);
  const hasPhotoAlready = !isNew && Boolean(material?.photoId);

  const pickMaterial = (m: Material) => {
    setMaterial(m);
    setIsNew(false);
    setQ('');
    setUsePhoto(!m.photoId);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!material && !isNew) return setError('Indica qué es: búscalo en el catálogo o da de alta uno nuevo');
    if (isNew && (!nm.description.trim() || !nm.familyId)) return setError('Del material nuevo, indica al menos qué es y su familia');
    if (!untracked && !n) return setError('Indica la cantidad');
    if (!disposition) return setError('Indica si se guarda en el almacén o se despliega directamente');
    setBusy(true);
    try {
      const r = await api.completeInbound(
        item.id,
        {
          ...(isNew
            ? { newMaterial: { description: nm.description.trim(), familyId: nm.familyId, unitCode: nm.unitCode, manufacturer: nm.manufacturer.trim() || undefined, manufacturerRef: nm.manufacturerRef.trim() || undefined } }
            : { materialId: material!.id }),
          quantity: untracked ? undefined : n!,
          lotCode: lot.trim() || undefined,
          projectRef: project.trim() || undefined,
          usagePlace: usage.trim() || undefined,
          disposition,
          ...(disposition === 'STORE' && dest ? dest.ref : {}),
          usePhotoForMaterial: usePhoto,
          note: note.trim() || undefined,
        },
        key,
      );
      props.onDone(r.message);
    } catch (err) {
      setError(errorMessage(err));
      setKey(newOperationKey());
    } finally {
      setBusy(false);
    }
  };

  if (picking) {
    return (
      <div className="card form op-form">
        <h3>¿Dónde se guarda?</h3>
        <PlacePicker
          hint="Escanea o escribe el sitio donde se va a guardar."
          onPick={(p) => {
            setDest(p);
            setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      </div>
    );
  }

  return (
    <form className="card form op-form" onSubmit={submit}>
      <h3>Completar el registro</h3>

      <div className="field">
        <span className="field-l">¿Qué es?</span>
        {material && !isNew ? (
          <p className="confirm">
            <strong>{material.description}</strong> · {material.internalRef}
            <button type="button" className="linkbtn" onClick={() => setMaterial(null)}>
              Cambiar
            </button>
          </p>
        ) : isNew ? (
          <div className="subcard">
            <div className="grid-2">
              <label className="field">
                <span>Descripción</span>
                <input value={nm.description} onChange={(e) => setNm({ ...nm, description: e.target.value })} maxLength={300} autoFocus />
              </label>
              <label className="field">
                <span>Familia</span>
                <select value={nm.familyId} onChange={(e) => {
                  const f = families.find((x) => x.id === e.target.value);
                  setNm({ ...nm, familyId: e.target.value, unitCode: f?.defaultUnitCode ?? nm.unitCode });
                }}>
                  <option value="">Elige…</option>
                  {families.map((f) => (
                    <option key={f.id} value={f.id}>{f.path}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Unidad</span>
                <select value={nm.unitCode} onChange={(e) => setNm({ ...nm, unitCode: e.target.value })}>
                  {units.map((u) => (
                    <option key={u.code} value={u.code}>{u.name} ({u.code})</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Fabricante <span className="muted">(opcional)</span></span>
                <input value={nm.manufacturer} onChange={(e) => setNm({ ...nm, manufacturer: e.target.value })} maxLength={120} />
              </label>
              <label className="field">
                <span>Referencia del fabricante <span className="muted">(opcional)</span></span>
                <input value={nm.manufacturerRef} onChange={(e) => setNm({ ...nm, manufacturerRef: e.target.value })} maxLength={120} />
              </label>
            </div>
            <button type="button" className="linkbtn" onClick={() => setIsNew(false)}>
              ← Buscar en el catálogo
            </button>
          </div>
        ) : (
          <>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Busca en el catálogo: nombre, referencia, fabricante…" />
            {q.trim() && (
              <div className="pick pick-short">
                {hits.map((m) => (
                  <button type="button" key={m.id} className="pick-btn" onClick={() => pickMaterial(m)}>
                    <span>
                      <b>{m.description}</b>
                      <small>{m.internalRef} · {m.familyName}</small>
                    </span>
                  </button>
                ))}
                {all !== null && hits.length === 0 && <p className="muted">No está en el catálogo.</p>}
              </div>
            )}
            <button type="button" className="btn" onClick={() => { setIsNew(true); setUsePhoto(true); }}>
              + Es un material nuevo
            </button>
          </>
        )}
      </div>

      {(material || isNew) && (
        <>
          {untracked ? (
            <p className="muted">Este material no se cuenta: solo se anota que ha llegado.</p>
          ) : (
            <div className="field">
              <span className="field-l">Cantidad</span>
              <QtyStepper value={qty} onChange={setQty} decimals={decimals} unit={unit} />
            </div>
          )}
          <div className="grid-2">
            <label className="field">
              <span>Proyecto <span className="muted">(opcional)</span></span>
              <input value={project} onChange={(e) => setProject(e.target.value)} maxLength={150} list="inbound-projects" placeholder="Código o nombre del proyecto" />
              <datalist id="inbound-projects">
                {projects.map((p) => <option key={p} value={p} />)}
              </datalist>
            </label>
            <label className="field">
              <span>Dónde se va a usar <span className="muted">(opcional)</span></span>
              <input value={usage} onChange={(e) => setUsage(e.target.value)} maxLength={300} placeholder="Máquina, banco, cliente…" />
            </label>
            <label className="field">
              <span>Lote {lotRequired ? '' : <span className="muted">(opcional)</span>}</span>
              <input value={lot} onChange={(e) => setLot(e.target.value)} maxLength={60} required={lotRequired} />
            </label>
          </div>

          <div className="field">
            <span className="field-l">¿Qué se hace con ello?</span>
            <div className="choices">
              <label className={`choice ${disposition === 'STORE' ? 'on' : ''}`}>
                <input type="radio" name="disp" checked={disposition === 'STORE'} onChange={() => setDisposition('STORE')} />
                <span>
                  <b>Se guarda en el almacén</b>
                  <small>Queda en el inventario para usarlo más adelante.</small>
                </span>
              </label>
              <label className={`choice ${disposition === 'DEPLOY' ? 'on' : ''}`}>
                <input type="radio" name="disp" checked={disposition === 'DEPLOY'} onChange={() => setDisposition('DEPLOY')} />
                <span>
                  <b>Se despliega directamente</b>
                  <small>Se usa ya: queda registrado que llegó y que salió, pero no se guarda.</small>
                </span>
              </label>
            </div>
          </div>
          {disposition === 'STORE' && (
            <div className="field">
              <span className="field-l">¿Dónde se guarda?</span>
              <div className="actions actions-wrap nomargin">
                <button type="button" className={`btn ${!dest ? 'on' : ''}`} onClick={() => setDest(null)}>
                  Donde está ahora: <strong className="mono">{item.placeCode}</strong>
                </button>
                <button type="button" className={`btn ${dest ? 'on' : ''}`} onClick={() => setPicking(true)}>
                  {dest ? <>En <strong className="mono">{dest.code}</strong> · cambiar</> : 'En otro sitio…'}
                </button>
              </div>
              {dest && <small className="muted">Se avisará a {item.receivedBy} para que lo lleve allí.</small>}
            </div>
          )}

          <label className="check">
            <input type="checkbox" checked={usePhoto} onChange={(e) => setUsePhoto(e.target.checked)} />
            <span>
              Usar la foto como foto del material
              {hasPhotoAlready && <small className="muted"> — el material ya tiene foto; se añadiría otra</small>}
            </span>
          </label>
          <label className="field">
            <span>Nota para {item.receivedBy} <span className="muted">(opcional)</span></span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Cuidado, frágil; avisadme cuando llegue el resto…" />
          </label>
        </>
      )}
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button className="btn btn-primary btn-big-inline" disabled={busy || (!material && !isNew)}>
          {busy ? 'Guardando…' : 'Completar registro'}
        </button>
      </div>
    </form>
  );
}

function ReassignForm(props: {
  item: Inbound; me: string; manager: boolean; onCancel: () => void; onDone: (name: string) => void; onGone: (name: string) => void;
}) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [who, setWho] = useState('');
  const [note, setNote] = useState('');
  const [key] = useState(newOperationKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.basicUsers().then((r) => setPeople(r.users)).catch((e) => setError(errorMessage(e)));
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!who) return setError('Elige a quién');
    setBusy(true);
    setError(null);
    try {
      const r = await api.reassignInbound(props.item.id, { responsibleUserId: who, note: note.trim() || undefined }, key);
      // Si deja de ser mía y no la registré yo ni las gestiono, ya no la puedo ver.
      if (!props.manager && props.item.receivedById !== props.me && who !== props.me) props.onGone(r.responsible);
      else props.onDone(r.responsible);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card form op-form" onSubmit={submit}>
      <h3>¿De quién es?</h3>
      <PersonPicker people={people} value={who} onChange={setWho} exclude={props.item.responsibleId} />
      <label className="field">
        <span>Nota <span className="muted">(opcional)</span></span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Creo que es del proyecto de…" />
      </label>
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>Cancelar</button>
        <button className="btn btn-primary" disabled={busy || !who}>{busy ? 'Pasando…' : 'Pasar y avisar'}</button>
      </div>
    </form>
  );
}

function CancelForm(props: { item: Inbound; onCancel: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [key] = useState(newOperationKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.cancelInbound(props.item.id, reason, key);
      props.onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card form op-form" onSubmit={submit}>
      <h3>Anular {props.item.code}</h3>
      <p className="muted">No se mueve nada de stock. Queda registrado quién la anuló y por qué.</p>
      <label className="field">
        <span>Motivo</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required autoFocus placeholder="Registrada dos veces, era un error…" />
      </label>
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>Volver</button>
        <button className="btn btn-danger" disabled={busy || !reason.trim()}>{busy ? 'Anulando…' : 'Anular'}</button>
      </div>
    </form>
  );
}
