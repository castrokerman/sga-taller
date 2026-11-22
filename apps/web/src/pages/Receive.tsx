import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage, formatQty, newOperationKey, type ContentType, type Material, type OpResult, type PlaceRef, type User } from '../api';
import { MaterialForm } from './Materials';
import { ReceiveBatch } from './ReceiveBatch';
import { shrink } from '../components/ItemExtras';
import { MaterialPicker, parseNumber, PlacePicker, QtyStepper, UnitLabels } from '../components/Stock';
import { navigate } from '../router';
import { PendingReceive } from './Inbound';
import { PlaceSelect } from '../components/PlaceSelect';
import { ContentsPhotoPrompt } from '../components/ContentsPhoto';

type Place = { ref: PlaceRef; code: string };
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
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
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
    setStep(3);
  };

  const restart = (keep: 'place' | 'material' | 'none') => {
    setResult(null);
    if (keep !== 'material') {
      setMaterial(null);
      setKind(null);
      setType(null);
    }
    if (keep !== 'place') setPlace(null);
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
          <button disabled={step === 4} onClick={() => { setMaterial(null); setStep(1); }}>
            1. Contenido{material && step > 1 ? `: ${material.description}` : type ? `: ${type.name}` : ''}
          </button>
        </li>
        <li className={step === 2 ? 'on' : step > 2 ? 'done' : undefined}>
          <button disabled={!material || step === 4} onClick={() => setStep(2)}>
            2. Dónde{place && step > 2 ? `: ${place.code}` : ''}
          </button>
        </li>
        <li className={step === 3 ? 'on' : step > 3 ? 'done' : undefined}>
          <span>3. Cantidad</span>
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
              setStep(place ? 3 : 2);
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
              setStep(place ? 3 : 2);
            }}
            onCancel={() => setKind(null)}
          />
        </div>
      )}

      {step === 2 && material && (
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
                <button className="btn" onClick={() => setStep(1)}>← Otro contenido</button>
              </div>
            </>
          )}
        </div>
      )}

      {step === 3 && material && place && (
        <QuantityStep
          user={user}
          material={material}
          place={place}
          onBack={() => setStep(2)}
          onDone={(r) => {
            setResult(r);
            setStep(4);
          }}
        />
      )}

      {step === 4 && result && material && place && (
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

function QuantityStep(props: { user: User; material: Material; place: Place; onBack: () => void; onDone: (r: OpResult) => void }) {
  const { material, place } = props;
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
  const [key, setKey] = useState(newOperationKey);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const n = parseNumber(qty);
  const canReturn = props.user.permissions.includes('stock.return');
  const canPhoto = props.user.permissions.includes('photo.add');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      setBusy('Registrando…');
      const r = await api.receive(
        {
          ...place.ref, materialId: material.id, quantity: untracked ? undefined : n, lotCode: lot.trim() || undefined,
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
      props.onDone(r);
    } catch (err) {
      setError(errorMessage(err));
      setKey(newOperationKey());
    } finally {
      setBusy(null);
    }
  };

  return (
    <form className="card form op-form" onSubmit={submit}>
      <h3>¿Cuánto entra en {place.code}?</h3>
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
