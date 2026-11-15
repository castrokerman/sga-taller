import { useRef, useState, type FormEvent } from 'react';
import { api, errorMessage, formatQty, newOperationKey, type Material, type OpResult, type PlaceRef, type User } from '../api';
import { shrink } from '../components/ItemExtras';
import { MaterialPicker, parseNumber, PlacePicker, QtyStepper } from '../components/Stock';
import { navigate } from '../router';
import { PendingReceive } from './Inbound';
import { PlaceSelect } from '../components/PlaceSelect';

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
 * Registrar entrada, paso a paso: qué material (o crearlo con su foto),
 * dónde se guarda (escaneando) y cuánto entra.
 */
export function ReceivePage({ user, initial }: { user: User; initial?: string }) {
  const [mode, setMode] = useState<'choose' | 'direct' | 'pending'>(initial === 'pendiente' ? 'pending' : initial === 'directa' ? 'direct' : 'choose');
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [material, setMaterial] = useState<Material | null>(null);
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
    if (keep !== 'material') setMaterial(null);
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
            <span>Lo eliges del catálogo (o lo das de alta), escaneas dónde lo guardas y la cantidad.</span>
          </button>
        </div>
      )}

      {mode === 'pending' && <PendingReceive user={user} onBack={() => setMode('choose')} />}

      {mode === 'direct' && (<>
      <ol className="steps">
        <li className={step === 1 ? 'on' : step > 1 ? 'done' : undefined}>
          <button disabled={step === 4} onClick={() => setStep(1)}>
            1. Material{material && step > 1 ? `: ${material.description}` : ''}
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

      {step === 1 && (
        <div className="card form op-form">
          <h3>¿Qué contenido entra?</h3>
          <MaterialPicker
            user={user}
            onPick={(m) => {
              setMaterial(m);
              setStep(place ? 3 : 2);
            }}
            onCancel={() => setMode('choose')}
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
            <a className="linkbtn" href={`#/material/${material.id}`}>
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
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Proveedor, para qué proyecto, estado…" />
      </label>
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
        <button className="btn btn-primary btn-big-inline" disabled={Boolean(busy) || (!untracked && !n)}>
          {busy ?? (untracked ? 'Registrar entrada' : `Registrar ${n ? formatQty(n, material.unitCode) : ''}`)}
        </button>
      </div>
    </form>
  );
}
