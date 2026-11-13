import { useState } from 'react';
import { api, errorMessage, type ContainerSummary, type LabelFormat, type LabelRef, type LocationSummary, type PathItem } from '../api';
import { navigate } from '../router';

/** Ruta de ubicaciones (y contenedores) hasta el elemento actual. */
export function Breadcrumbs(props: { locations: PathItem[]; containers?: PathItem[]; current?: string }) {
  const containers = props.containers ?? [];
  return (
    <nav className="crumbs" aria-label="Ruta">
      <a href="#/almacen">Almacén</a>
      {props.locations.map((l) => (
        <span key={l.id}>
          <i aria-hidden="true">›</i>
          {l.id === props.current ? <strong>{l.code}</strong> : <a href={`#/almacen/${l.id}`}>{l.code}</a>}
        </span>
      ))}
      {containers.map((c) => (
        <span key={c.id}>
          <i aria-hidden="true">›</i>
          {c.id === props.current ? <strong>{c.code}</strong> : <a href={`#/contenedor/${c.id}`}>{c.code}</a>}
        </span>
      ))}
    </nav>
  );
}

export function LocationCard({ l }: { l: LocationSummary }) {
  return (
    <button className="item" onClick={() => navigate(`almacen/${l.id}`)}>
      <span className="item-main">
        <strong>{l.code}</strong>
        <span>{l.name}</span>
      </span>
      <span className="item-meta">
        <span className="tag">{l.typeName}</span>
        <span>
          {l.childCount > 0 && `${l.childCount} ubic. `}
          {l.containerCount > 0 && `${l.containerCount} cont.`}
          {l.childCount === 0 && l.containerCount === 0 && 'Vacía'}
        </span>
      </span>
    </button>
  );
}

export function ContainerCard({ c }: { c: ContainerSummary }) {
  return (
    <button className="item item-container" onClick={() => navigate(`contenedor/${c.id}`)}>
      <span className="item-main">
        <strong>{c.code}</strong>
        <span>{c.description ?? c.typeName}</span>
      </span>
      <span className="item-meta">
        <span className="tag">{c.typeName}</span>
        <span>{c.childCount > 0 ? `${c.childCount} dentro` : ''}</span>
      </span>
    </button>
  );
}

const FORMAT_KEY = 'sga.formato-etiqueta';

function storedFormat(): LabelFormat {
  try {
    return window.localStorage.getItem(FORMAT_KEY) === 'a4-24' ? 'a4-24' : '4x6';
  } catch {
    return '4x6';
  }
}

/** Botones para descargar el PDF de etiquetas de uno o varios grupos de elementos. */
export function LabelPanel(props: { groups: Array<{ label: string; items: LabelRef[] }>; onClose: () => void }) {
  const [format, setFormat] = useState<LabelFormat>(storedFormat);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = (f: LabelFormat) => {
    setFormat(f);
    try {
      window.localStorage.setItem(FORMAT_KEY, f);
    } catch {
      /* sin almacenamiento local: se usa solo en esta pantalla */
    }
  };

  const print = async (items: LabelRef[]) => {
    setBusy(true);
    setError(null);
    try {
      await api.downloadLabels(items, format);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form">
      <h3>Imprimir etiquetas QR</h3>
      <fieldset className="field">
        <legend>Formato</legend>
        <label className="check">
          <input type="radio" name="formato" checked={format === '4x6'} onChange={() => choose('4x6')} />
          <span>
            <strong>Etiqueta de 6 × 4 pulgadas</strong>
            <small className="muted"> — una por página, para impresora de etiquetas</small>
          </span>
        </label>
        <label className="check">
          <input type="radio" name="formato" checked={format === 'a4-24'} onChange={() => choose('a4-24')} />
          <span>
            <strong>Hoja A4 de 24 pegatinas</strong>
            <small className="muted"> — 70 × 37 mm, para impresora normal</small>
          </span>
        </label>
      </fieldset>

      <div className="stack">
        {props.groups
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <button key={g.label} className="btn" disabled={busy} onClick={() => print(g.items)}>
              {g.label} ({g.items.length})
            </button>
          ))}
      </div>
      <p className="muted small">
        Se descarga un PDF. Al imprimirlo, elige tamaño real o escala al 100 % para que las etiquetas no se
        descuadren.
      </p>
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button className="btn" onClick={props.onClose}>
          Cerrar
        </button>
      </div>
    </div>
  );
}
