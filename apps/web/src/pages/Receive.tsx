import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage, formatQty, newOperationKey, type ContainerType, type ContentType, type Material, type OpResult, type PlaceRef, type TreeContainer, type User } from '../api';
import { normalize } from '../components/ListControls';
import { attachDocPhoto, DocPhotoField } from '../components/DocPhoto';
import { MaterialForm } from './Materials';
import { ReceiveBatch } from './ReceiveBatch';
import { shrink } from '../components/ItemExtras';
import { MaterialPicker, parseNumber, PlacePicker, QtyStepper, UnitLabels } from '../components/Stock';
import { navigate } from '../router';
import { PendingReceive } from './Inbound';
import { PlaceSelect } from '../components/PlaceSelect';
import { ContentsPhotoPrompt } from '../components/ContentsPhoto';

type Place = { ref: PlaceRef; code: string };

/** Paso 2 de una entrada: contenedor nuevo que llega con ello, uno que ya existe, o ninguno. */
type BoxChoice =
  | { kind: 'new'; typeCode: string; typeName: string; description: string }
  | { kind: 'existing'; id: string; code: string; where: string | null }
  | { kind: 'none' };

const boxLabel = (b: BoxChoice) =>
  b.kind === 'new' ? `${b.typeName.toLowerCase()} nuevo` : b.kind === 'existing' ? b.code : 'sin contenedor';
const LAST_PLACE = 'sga.entrada-ultimo-sitio';

const readLast = (): Place | null => {
  try {
    return JSON.parse(window.localStorage.getItem(LAST_PLACE) ?? 'null');
  } catch {
    return null;
  }
};

/**
 * Registrar entrada, paso a paso: el tipo de contenido; si es un contenido
 * nuevo (se da de alta, con su foto) o uno ya registrado (se repone); dónde se
 * guarda; y cuánto entra y para quién (un proyecto, una persona o el taller).
 */
export function ReceivePage({ user, initial }: { user: User; initial?: string }) {
  const [mode, setMode] = useState<'choose' | 'direct' | 'pending' | 'batch'>(
    initial === 'pendiente' ? 'pending' : initial === 'directa' ? 'direct' : initial === 'varias' ? 'batch' : 'choose',
  );
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  // Paso 2: en qué contenedor viene o se guarda.
  const [box, setBox] = useState<BoxChoice | null>(null);
  const [types, setTypes] = useState<ContentType[]>([]);
  const [type, setType] = useState<ContentType | null>(null);
  const [kind, setKind] = useState<'new' | 'existing' | null>(null);
  const [material, setMaterial] = useState<Material | null>(null);
  useEffect(() => {
    api.contentTypes().then((r) => setTypes(r.types.filter((t) => t.active))).catch(() => undefined);
  }, []);
  const [place, setPlace] = useState<Place | null>(null);
  const [result, setResult] = useState<OpResult | null>(null);
  const [last, setLast] = useState<Place | null>(readLast);
  const [scanning, setScanning] = useState(false);

  const choosePlace = (p: Place) => {
    setPlace(p);
    setLast(p);
    try {
      window.localStorage.setItem(LAST_PLACE, JSON.stringify(p));
    } catch {
      /* sin almacenamiento local */
    }
    setStep(4);
  };

  const restart = (keep: 'place' | 'material' | 'none') => {
    setResult(null);
    if (keep !== 'material') {
      setMaterial(null);
      setKind(null);
      setType(null);
    }
    if (keep !== 'place') {
      setPlace(null);
      setBox(null);
    }
    setStep(keep === 'material' ? 2 : 1);
  };

  return (
    <>
      <nav className="crumbs">
        <a href="#/inicio">Inicio</a>
        <span>
          <i>›</i>
          <strong>Registrar entrada</strong>
        </span>
      </nav>
      <div className="page-head">
        <div>
          <h2>Registrar entrada</h2>
          <p className="muted nomargin">Lo que llega al almacén o vuelve a él.</p>
        </div>
      </div>

      {mode === 'choose' && (
        <div className="mode-choice">
          <button className="mode-card" onClick={() => setMode('pending')}>
            <span className="mode-icon" aria-hidden="true">📷</span>
            <b>Lo identifica el responsable</b>
            <span>No sabes qué es: haz una foto, di de quién es y dónde lo dejas. Le llega un aviso para completar el registro.</span>
          </button>
          <button className="mode-card" onClick={() => setMode('direct')}>
            <span className="mode-icon" aria-hidden="true">✓</span>
            <b>Sé lo que es</b>
            <span>Eliges el tipo, si es nuevo o ya registrado, dónde lo guardas y la cantidad.</span>
          </button>
          <button className="mode-card" onClick={() => setMode('batch')}>
            <span className="mode-icon" aria-hidden="true">☰</span>
            <b>Varias cosas a la vez</b>
            <span>Una lista con una fila por cosa: se rellena, se revisa y se registra todo de una vez.</span>
          </button>
        </div>
      )}

      {mode === 'pending' && <PendingReceive user={user} onBack={() => setMode('choose')} />}
      {mode === 'batch' && <ReceiveBatch user={user} onBack={() => setMode('choose')} />}

      {mode === 'direct' && (<>
      <ol className="steps">
        <li className={step === 1 ? 'on' : step > 1 ? 'done' : undefined}>
          <button disabled={step === 5} onClick={() => { setMaterial(null); setStep(1); }}>
            1. Contenido{material && step > 1 ? `: ${material.description}` : type ? `: ${type.name}` : ''}
          </button>
        </li>
        <li className={step === 2 ? 'on' : step > 2 ? 'done' : undefined}>
          <button disabled={!material || step === 5} onClick={() => setStep(2)}>
            2. Contenedor{box && step > 2 ? `: ${boxLabel(box)}` : ''}
          </button>
        </li>
        <li className={step === 3 ? 'on' : step > 3 ? 'done' : undefined}>
          <button disabled={!material || !box || step === 5} onClick={() => setStep(3)}>
            3. Dónde{place && step > 3 ? `: ${place.code}` : ''}
          </button>
        </li>
        <li className={step === 4 ? 'on' : step > 4 ? 'done' : undefined}>
          <span>4. Cantidad</span>
        </li>
      </ol>

      {step === 1 && !type && (
        <div className="card form op-form">
          <h3>¿Qué tipo de contenido entra?</h3>
          <div className="type-choice">
            {types.map((t) => (
              <button key={t.code} type="button" className="type-btn" onClick={() => { setType(t); setKind(null); }}>
                <b>{t.name}</b>
                <small>{t.unitTracked ? 'De uno en uno, cada uno con su código' : 'Por cantidad'}</small>
              </button>
            ))}
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setMode('choose')}>Cancelar</button>
          </div>
        </div>
      )}

      {step === 1 && type && !kind && (
        <div className="card form op-form">
          <h3>{type.name}: ¿es nuevo o ya está registrado?</h3>
          <div className="mode-choice">
            {user.permissions.includes('material.manage') && (
              <button className="mode-card" onClick={() => setKind('new')}>
                <span className="mode-icon" aria-hidden="true">＋</span>
                <b>Contenido nuevo</b>
                <span>No está en el catálogo: se da de alta (con su foto) y entra.</span>
              </button>
            )}
            <button className="mode-card" onClick={() => setKind('existing')}>
              <span className="mode-icon" aria-hidden="true">↻</span>
              <b>Contenido ya registrado</b>
              <span>Ya está en el catálogo: reponer o aumentar lo que hay.</span>
            </button>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setType(null)}>← Otro tipo</button>
          </div>
        </div>
      )}

      {step === 1 && type && kind === 'new' && (
        <div className="card form op-form">
          <h3>{type.name} nuevo</h3>
          <MaterialForm
            title=""
            embedded
            fixedType={type.code}
            canPhoto={user.permissions.includes('photo.add')}
            onCancel={() => setKind(null)}
            onDone={(m) => {
              setMaterial(m);
              setStep(2);
            }}
          />
        </div>
      )}

      {step === 1 && type && kind === 'existing' && (
        <div className="card form op-form">
          <h3>¿Qué {type.name.toLowerCase()} entra?</h3>
          <MaterialPicker
            user={user}
            type={type.code}
            noCreate
            onPick={(m) => {
              setMaterial(m);
              setStep(2);
            }}
            onCancel={() => setKind(null)}
          />
        </div>
      )}

      {step === 2 && material && (
        <BoxStep
          material={material}
          canCreate={user.permissions.includes('container.manage')}
          onBack={() => setStep(1)}
          onPick={(b) => {
            setBox(b);
            if (b.kind === 'existing') setPlace({ ref: { containerId: b.id }, code: b.code });
            else if (b.kind === 'new') setPlace(null);
            setStep(3);
          }}
        />
      )}

      {step === 3 && material && box?.kind === 'existing' && place && (
        <div className="card form op-form">
          <h3>¿Dónde lo guardas?</h3>
          <p className="confirm">
            <strong>{material.description}</strong> se guarda en <strong className="mono">{box.code}</strong>
            {box.where && <span className="muted"> (en {box.where})</span>}.
          </p>
          <div className="actions">
            <button className="btn" onClick={() => setStep(2)}>← Otro contenedor</button>
            <button className="btn btn-primary btn-big-inline" onClick={() => setStep(4)}>Seguir</button>
          </div>
        </div>
      )}

      {step === 3 && material && box?.kind === 'new' && (
        <div className="card form op-form">
          <h3>¿Dónde se deja el {box.typeName.toLowerCase()} nuevo?</h3>
          <p className="confirm">
            <strong>{material.description}</strong> entra en un {box.typeName.toLowerCase()} nuevo{box.description ? ` (${box.description})` : ''}, que se
            registra con su código y su etiqueta.
          </p>
          <PlaceSelect value={null} moving containerType={box.typeCode} onChange={(p) => p && choosePlace(p)} />
          <small className="muted">Una ubicación o dentro de otro contenedor. Las que no admiten {box.typeName.toLowerCase()} salen en gris.</small>
          <div className="actions">
            <button className="btn" onClick={() => setStep(2)}>← Otra opción</button>
          </div>
        </div>
      )}

      {step === 3 && material && box?.kind === 'none' && (
        <div className="card form op-form">
          <h3>¿Dónde lo guardas?</h3>
          <p className="confirm">
            <strong>{material.description}</strong> · {material.internalRef}
          </p>
          {scanning ? (
            <PlacePicker
              hint="Escanea la etiqueta de la caja, bandeja o ubicación, o escribe su código."
              scanOnly
              onPick={(p) => { setScanning(false); choosePlace(p); }}
              onCancel={() => setScanning(false)}
            />
          ) : (
            <>
              <PlaceSelect value={null} onChange={(p) => p && choosePlace(p)} />
              <div className="place-extra">
                {last && (
                  <button className="linkbtn" onClick={() => choosePlace(last)}>
                    El mismo que la última vez: <strong className="mono">{last.code}</strong>
                  </button>
                )}
                <button className="linkbtn" onClick={() => setScanning(true)}>
                  📷 O escanea su etiqueta
                </button>
              </div>
              <div className="actions">
                <button className="btn" onClick={() => setStep(2)}>← Otra opción de contenedor</button>
              </div>
            </>
          )}
        </div>
      )}

      {step === 4 && material && place && box && (
        <QuantityStep
          user={user}
          material={material}
          place={place}
          newBox={box.kind === 'new' ? box : undefined}
          onBack={() => setStep(3)}
          onDone={(r, created) => {
            setResult(r);
            // El contenedor recién creado ya existe: la siguiente entrada puede ir en él.
            if (created) {
              setPlace({ ref: { containerId: created.id }, code: created.code });
              setBox({ kind: 'existing', id: created.id, code: created.code, where: place.code });
            }
            setStep(5);
          }}
        />
      )}

      {step === 5 && result && material && place && (
        <div className="card form op-form done-card">
          <h3>Entrada registrada</h3>
          <p>{result.message}.</p>
          <p className="muted small">Movimiento n.º {result.movementNumber}, a nombre de {user.fullName}.</p>
          {result.containers && result.containers.length > 0 && <ContentsPhotoPrompt containers={result.containers} user={user} />}
          {result.units && result.units.length > 0 && (
            <>
              <p className="small nomargin">Pega a cada unidad su etiqueta, para que se pueda escanear al prestarla o moverla.</p>
              <UnitLabels units={result.units} />
            </>
          )}
          <div className="actions actions-wrap">
            <button className="btn btn-primary" onClick={() => restart('place')}>
              Otra entrada en {place.code}
            </button>
            <button className="btn" onClick={() => restart('material')}>
              Más {material.description} en otro sitio
            </button>
            <button className="btn" onClick={() => restart('none')}>
              Empezar de cero
            </button>
          </div>
          <div className="actions actions-wrap">
            <a className="linkbtn" href={`#/contenido/${material.id}`}>
              Ver la ficha del contenido
            </a>
            <a className="linkbtn" href={place.ref.containerId ? `#/contenedor/${place.ref.containerId}` : `#/almacen/${place.ref.locationId}`}>
              Ver {place.code}
            </a>
          </div>
        </div>
      )}
      </>)}
    </>
  );
}

function QuantityStep(props: {
  user: User; material: Material; place: Place;
  /** Contenedor nuevo que se crea en `place` y en el que entra el contenido. */
  newBox?: Extract<BoxChoice, { kind: 'new' }>;
  onBack: () => void;
  onDone: (r: OpResult, created?: { id: string; code: string }) => void;
}) {
  const { material, place } = props;
  const [created, setCreated] = useState<{ id: string; code: string } | null>(null);
  const [boxKey, setBoxKey] = useState(newOperationKey);
  const [full, setFull] = useState<string | null>(null);
  const untracked = material.quantityTracking === 'NOT_TRACKED';
  const [qty, setQty] = useState('1');
  const [lot, setLot] = useState('');
  const [albaran, setAlbaran] = useState('');
  const [note, setNote] = useState('');
  const [isReturn, setIsReturn] = useState(false);
  const [forWhom, setForWhom] = useState<'taller' | 'reservado'>('taller');
  const [projectId, setProjectId] = useState('');
  const [personId, setPersonId] = useState('');
  const [projects, setProjects] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [people, setPeople] = useState<Array<{ id: string; fullName: string }>>([]);
  useEffect(() => {
    api.projects().then((r) => setProjects(r.projects.filter((p) => p.status === 'ACTIVE'))).catch(() => undefined);
    api.basicUsers().then((r) => setPeople(r.users)).catch(() => undefined);
  }, []);
  const [photo, setPhoto] = useState<File | null>(null);
  const [docPhoto, setDocPhoto] = useState<File | null>(null);
  const [key, setKey] = useState(newOperationKey);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const n = parseNumber(qty);
  const canReturn = props.user.permissions.includes('stock.return');
  const canPhoto = props.user.permissions.includes('photo.add');

  const submit = async (e: FormEvent | null, force = false) => {
    e?.preventDefault();
    setError(null);
    setFull(null);
    try {
      let target = place.ref;
      let box = created;
      if (props.newBox && !box) {
        setBusy('Creando el contenedor…');
        const k = (await api.createContainers({
          typeCode: props.newBox.typeCode, quantity: 1, description: props.newBox.description || undefined, ...place.ref, force,
        }, force ? newOperationKey() : boxKey)).containers[0]!;
        box = { id: k.id, code: k.code };
        setCreated(box);
      }
      if (box) target = { containerId: box.id };
      setBusy('Registrando…');
      const r = await api.receive(
        {
          ...target, materialId: material.id, quantity: untracked ? undefined : n, lotCode: lot.trim() || undefined,
          externalReference: albaran.trim() || undefined, reason: note.trim() || undefined, isReturn,
          ...(forWhom === 'reservado' ? { projectId: projectId || undefined, responsibleUserId: personId || undefined } : {}),
        },
        key,
      );
      // La foto se añade a la ficha del material. Si falla, la entrada ya está hecha.
      if (photo) {
        setBusy('Subiendo foto…');
        try {
          await api.addPhoto({ entityType: 'material', entityId: material.id, ...(await shrink(photo)) }, newOperationKey());
        } catch (err) {
          r.message += `. La foto no se ha podido subir (${errorMessage(err)}); puedes añadirla desde la ficha`;
        }
      }
      if (docPhoto) {
        setBusy('Guardando la foto del albarán…');
        r.message += await attachDocPhoto(r.movementId, docPhoto);
      }
      if (box) r.message = `${props.newBox!.typeName} nuevo ${box.code} registrado en ${place.code}. ${r.message}`;
      props.onDone(r, box ?? undefined);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CAPACIDAD_SUPERADA') {
        setFull(err.message);
        setBoxKey(newOperationKey());
      } else {
        setError(errorMessage(err));
        setKey(newOperationKey());
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <form className="card form op-form" onSubmit={submit}>
      <h3>¿Cuánto entra en {props.newBox ? `el ${props.newBox.typeName.toLowerCase()} nuevo (en ${place.code})` : place.code}?</h3>
      <p className="confirm">
        <strong>{material.description}</strong> · {material.internalRef}
        {material.places > 0 && !untracked && <span className="muted"> · ya hay {formatQty(material.quantity, material.unitCode, material.quantityTracking)} en total</span>}
      </p>
      {untracked ? (
        <p className="muted">Este contenido no se cuenta: solo se anota que hay en este sitio.</p>
      ) : material.unitTracked ? (
        <>
          <span className="field-l">¿Cuántas unidades?</span>
          <QtyStepper value={qty} onChange={setQty} decimals={0} unit="unidades" autoFocus />
          <small className="muted">
            {material.contentTypeName} se lleva por unidad: cada una tendrá su propio código y su etiqueta QR
            {material.places > 0 || (material.onLoan ?? 0) > 0 ? ` (esta ya está registrada, así que se crearán unidades nuevas con los mismos datos)` : ''}.
          </small>
        </>
      ) : (
        <>
          <span className="field-l">Cantidad</span>
          <QtyStepper value={qty} onChange={setQty} decimals={material.decimals} unit={material.unitCode} autoFocus />
        </>
      )}
      <div className="grid-2" style={{ marginTop: '1rem' }}>
        {!material.unitTracked && (
        <label className="field">
          <span>
            Lote {material.lotTracked ? '' : <span className="muted">(opcional)</span>}
          </span>
          <input value={lot} onChange={(e) => setLot(e.target.value)} maxLength={60} required={material.lotTracked} />
        </label>
        )}
        <label className="field">
          <span>
            Albarán o pedido <span className="muted">(opcional)</span>
          </span>
          <input value={albaran} onChange={(e) => setAlbaran(e.target.value)} maxLength={80} />
          <DocPhotoField file={docPhoto} onChange={setDocPhoto} />
        </label>
      </div>
      <label className="field">
        <span>
          Nota <span className="muted">(opcional)</span>
        </span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Proveedor, estado…" />
      </label>
      <div className="field">
        <span className="field-l">¿Para quién es?</span>
        <div className="pchips">
          <button type="button" className={`pchip ${forWhom === 'taller' ? 'on' : ''}`} onClick={() => setForWhom('taller')}>
            Uso general del taller
          </button>
          <button type="button" className={`pchip ${forWhom === 'reservado' ? 'on' : ''}`} onClick={() => setForWhom('reservado')}>
            Para un proyecto o una persona
          </button>
        </div>
        {forWhom === 'reservado' && (
          <div className="grid-2">
            <label className="field">
              <span>Proyecto</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Ninguno</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Persona responsable</span>
              <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
                <option value="">Ninguna</option>
                {people.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <small className="muted">
          {forWhom === 'taller'
            ? 'Lo puede usar cualquiera del taller.'
            : 'Queda reservado: solo lo sacan los responsables del proyecto, esa persona y el responsable de almacén.'}
        </small>
      </div>
      {canPhoto && (
        <div className="field">
          <span className="field-l">Foto del contenido <span className="muted">(opcional)</span></span>
          <label className="btn">
            {photo ? `📷 ${photo.name}` : '📷 Hacer o elegir foto'}
            <input ref={input} type="file" accept="image/*" hidden onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </label>
          {photo && (
            <button type="button" className="linkbtn" onClick={() => { setPhoto(null); if (input.current) input.current.value = ''; }}>
              Quitar
            </button>
          )}
          <small className="muted" style={{ display: 'block' }}>Se añade a la ficha del contenido.</small>
        </div>
      )}
      {canReturn && (
        <label className="check">
          <input type="checkbox" checked={isReturn} onChange={(e) => setIsReturn(e.target.checked)} />
          <span>
            <strong>Es una devolución</strong>
            <small className="muted"> — contenido que se sacó y vuelve sin usar</small>
          </span>
        </label>
      )}
      {error && <p className="alert alert-error">{error}</p>}
      {full && (
        <div className="alert alert-warn">
          {full}. ¿Lo dejas ahí igualmente?{' '}
          <button type="button" className="btn btn-small" disabled={Boolean(busy)} onClick={() => void submit(null, true)}>
            Dejarlo igualmente
          </button>{' '}
          <button type="button" className="linkbtn small" onClick={props.onBack}>Elegir otro sitio</button>
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onBack} disabled={Boolean(busy)}>
          ← Otro sitio
        </button>
        <button className="btn btn-primary btn-big-inline" disabled={Boolean(busy) || (!untracked && !n) || (forWhom === 'reservado' && !projectId && !personId)}>
          {busy ??
            (untracked
              ? 'Registrar entrada'
              : material.unitTracked
                ? `Registrar ${n ?? ''} ${n === 1 ? 'unidad' : 'unidades'}`
                : `Registrar ${n ? formatQty(n, material.unitCode) : ''}`)}
        </button>
      </div>
    </form>
  );
}

/**
 * Paso 2: ¿viene en un contenedor nuevo que hay que registrar (un palet, una
 * caja)? ¿Se guarda en uno que ya existe? ¿O no necesita contenedor?
 */
function BoxStep(props: { material: Material; canCreate: boolean; onBack: () => void; onPick: (b: BoxChoice) => void }) {
  const [mode, setMode] = useState<'new' | 'existing' | null>(null);
  const [types, setTypes] = useState<ContainerType[]>([]);
  const [typeCode, setTypeCode] = useState('');
  const [description, setDescription] = useState('');
  const [all, setAll] = useState<{ containers: TreeContainer[]; locs: Map<string, string> } | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    api.containerTypes().then((r) => {
      const active = r.types.filter((t) => t.active);
      setTypes(active);
      setTypeCode((cur) => cur || active[0]?.code || '');
    }).catch(() => undefined);
    api.tree().then((r) => setAll({ containers: r.containers, locs: new Map(r.locations.map((l) => [l.id, l.code])) })).catch(() => undefined);
  }, []);

  const where = (c: TreeContainer) =>
    c.locationId ? all?.locs.get(c.locationId) ?? null : all?.containers.find((x) => x.id === c.parentContainerId)?.code ?? null;
  const words = normalize(q).split(/\s+/).filter(Boolean);
  const hits = (all?.containers ?? [])
    .filter((c) => {
      const text = normalize([c.code, c.description, c.contentDescription, c.typeName, where(c)].filter(Boolean).join(' '));
      return words.every((w) => text.includes(w));
    })
    .slice(0, 15);

  return (
    <div className="card form op-form">
      <h3>¿En qué contenedor?</h3>
      <p className="confirm">
        <strong>{props.material.description}</strong> · {props.material.internalRef}
      </p>
      {!mode && (
        <>
          <div className="mode-choice">
            {props.canCreate && (
              <button className="mode-card" onClick={() => setMode('new')}>
                <span className="mode-icon" aria-hidden="true">＋</span>
                <b>Viene con un contenedor nuevo</b>
                <span>Llega en su propio palet o caja y hay que registrarlo: se crea con su código y su etiqueta.</span>
              </button>
            )}
            <button className="mode-card" onClick={() => setMode('existing')}>
              <span className="mode-icon" aria-hidden="true">▣</span>
              <b>En un contenedor que ya existe</b>
              <span>Se guarda en un palet, caja o bandeja que ya está en el almacén.</span>
            </button>
            <button className="mode-card" onClick={() => props.onPick({ kind: 'none' })}>
              <span className="mode-icon" aria-hidden="true">→</span>
              <b>No necesita contenedor</b>
              <span>Va directo a un armario, una cajonera u otra ubicación que guarda contenido.</span>
            </button>
          </div>
          <div className="actions">
            <button className="btn" onClick={props.onBack}>← Otro contenido</button>
          </div>
        </>
      )}
      {mode === 'new' && (
        <>
          <div className="field">
            <span className="field-l">Tipo de contenedor</span>
            <div className="pchips">
              {types.map((t) => (
                <button key={t.code} type="button" className={`pchip ${typeCode === t.code ? 'on' : ''}`} onClick={() => setTypeCode(t.code)}>
                  {t.name}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>
              Descripción del contenedor <span className="muted">(opcional)</span>
            </span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="Palet del proveedor, caja azul…" />
          </label>
          <div className="actions">
            <button className="btn" onClick={() => setMode(null)}>← Otra opción</button>
            <button
              className="btn btn-primary btn-big-inline"
              disabled={!typeCode}
              onClick={() => {
                const t = types.find((x) => x.code === typeCode)!;
                props.onPick({ kind: 'new', typeCode, typeName: t.name, description: description.trim() });
              }}
            >
              Seguir: dónde se deja
            </button>
          </div>
        </>
      )}
      {mode === 'existing' && (
        <>
          <label className="field">
            <span>¿Qué contenedor?</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Código, descripción, lo que lleva o dónde está" autoFocus />
          </label>
          {all === null ? (
            <p className="muted">Cargando…</p>
          ) : (
            <div className="pick">
              {hits.map((c) => (
                <button key={c.id} type="button" className="pick-btn" onClick={() => props.onPick({ kind: 'existing', id: c.id, code: c.code, where: where(c) })}>
                  <span>
                    <b className="mono">{c.code}</b>
                    <small>{[c.typeName, c.description, c.contentDescription && `📦 ${c.contentDescription}`].filter(Boolean).join(' · ')}</small>
                  </span>
                  <span className="r small">{where(c) ?? ''}</span>
                </button>
              ))}
              {hits.length === 0 && <p className="muted">Ningún contenedor coincide.</p>}
            </div>
          )}
          <div className="actions">
            <button className="btn" onClick={() => setMode(null)}>← Otra opción</button>
          </div>
        </>
      )}
    </div>
  );
}
