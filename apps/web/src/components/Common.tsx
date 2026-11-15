import { useState } from 'react';
import { api, errorMessage, photoUrl, type ContainerSummary, type LabelFormat, type LabelRef, type LocationSummary, type PathItem } from '../api';
import { navigate } from '../router';
import { Highlight, optionsFrom, type ListConfig } from './ListControls';

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

export function LocationCard({ l, q = '' }: { l: LocationSummary; q?: string }) {
  const over = l.maxCapacity !== null && l.containerCount > l.maxCapacity;
  return (
    <button className="item" onClick={() => navigate(`almacen/${l.id}`)}>
      {l.photoId && <img className="item-photo" src={photoUrl(l.photoId)} alt="" loading="lazy" />}
      <span className="item-main">
        <strong><Highlight text={l.code} query={q} /></strong>
        <span><Highlight text={l.name} query={q} /></span>
      </span>
      <span className="item-meta">
        <span className="tag">{l.typeName}</span>
        <span className={over ? 'over' : undefined}>
          {l.childCount > 0 && `${l.childCount} ubic. `}
          {l.containerCount > 0 &&
            (l.maxCapacity !== null ? `${l.containerCount} de ${l.maxCapacity} cont.` : `${l.containerCount} cont.`)}
          {l.childCount === 0 && l.containerCount === 0 && 'Vacía'}
        </span>
      </span>
    </button>
  );
}

export function ContainerCard({ c, q = '' }: { c: ContainerSummary; q?: string }) {
  return (
    <button className="item item-container" onClick={() => navigate(`contenedor/${c.id}`)}>
      {c.photoId && <img className="item-photo" src={photoUrl(c.photoId)} alt="" loading="lazy" />}
      <span className="item-main">
        <strong><Highlight text={c.code} query={q} /></strong>
        <span><Highlight text={c.description ?? c.typeName} query={q} /></span>
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

// ---- Configuración de orden y filtros, común a todas las pantallas --------


const time = (iso: string) => new Date(iso).getTime();

export function locationListConfig(items: LocationSummary[], storageKey: string): ListConfig<LocationSummary> {
  return {
    storageKey,
    noun: 'ubicaciones',
    text: (l) => [l.code, l.name, l.description],
    sorts: [
      { key: 'codigo', label: 'Código (1, 2, 10)', value: (l) => l.code },
      { key: 'codigo-alfa', label: 'Código alfanumérico (1, 10, 2)', value: (l) => l.code, alphanumeric: true },
      { key: 'nombre', label: 'Nombre', value: (l) => l.name },
      { key: 'tipo', label: 'Tipo', value: (l) => l.typeName },
      { key: 'contenedores', label: 'Nº de contenedores', value: (l) => l.containerCount, defaultDir: 'desc' },
      { key: 'alta', label: 'Fecha de alta', value: (l) => time(l.createdAt), defaultDir: 'desc' },
    ],
    filters: [
      { key: 'tipo', label: 'Tipo', options: optionsFrom(items, (l) => l.typeName), test: (l, v) => l.typeName === v },
      {
        key: 'ocupacion', label: 'Ocupación',
        options: [
          { value: 'vacia', label: 'Vacías' },
          { value: 'ocupada', label: 'Con contenido' },
          { value: 'superada', label: 'Capacidad superada' },
        ],
        test: (l, v) =>
          v === 'vacia' ? l.childCount === 0 && l.containerCount === 0
          : v === 'ocupada' ? l.childCount > 0 || l.containerCount > 0
          : l.maxCapacity !== null && l.containerCount > l.maxCapacity,
      },
    ],
  };
}

export function containerListConfig(items: ContainerSummary[], storageKey: string): ListConfig<ContainerSummary> {
  return {
    storageKey,
    noun: 'contenedores',
    text: (c) => [c.code, c.description, c.typeName, c.responsibleName],
    sorts: [
      { key: 'codigo', label: 'Código (1, 2, 10)', value: (c) => c.code },
      { key: 'codigo-alfa', label: 'Código alfanumérico (1, 10, 2)', value: (c) => c.code, alphanumeric: true },
      { key: 'tipo', label: 'Tipo', value: (c) => c.typeName },
      { key: 'descripcion', label: 'Descripción', value: (c) => c.description },
      { key: 'responsable', label: 'Responsable', value: (c) => c.responsibleName },
      { key: 'alta', label: 'Fecha de alta', value: (c) => time(c.createdAt), defaultDir: 'desc' },
    ],
    filters: [
      { key: 'tipo', label: 'Tipo', options: optionsFrom(items, (c) => c.typeName), test: (c, v) => c.typeName === v },
      {
        key: 'responsable', label: 'Responsable',
        options: [{ value: '__ninguno', label: 'Sin responsable' }, ...optionsFrom(items, (c) => c.responsibleName)],
        test: (c, v) => (v === '__ninguno' ? !c.responsibleName : c.responsibleName === v),
      },
      {
        key: 'politica', label: 'Política',
        options: [{ value: 'REUSABLE', label: 'Reutilizable' }, { value: 'DISPOSABLE', label: 'Desechable' }],
        test: (c, v) => c.reusePolicy === v,
      },
      {
        key: 'contenido', label: 'Contenido',
        options: [{ value: 'vacio', label: 'Sin nada dentro' }, { value: 'lleno', label: 'Con contenedores dentro' }],
        test: (c, v) => (v === 'vacio' ? c.childCount === 0 : c.childCount > 0),
      },
    ],
  };
}

/** Selector «Lista | Árbol» de la pantalla principal del almacén. */
export function ViewSwitch(props: { view: 'lista' | 'arbol'; onChange: (v: 'lista' | 'arbol') => void }) {
  return (
    <div className="viewswitch push-right" role="group" aria-label="Vista">
      <button className={props.view === 'lista' ? 'on' : ''} aria-pressed={props.view === 'lista'} onClick={() => props.onChange('lista')}>
        Lista
      </button>
      <button className={props.view === 'arbol' ? 'on' : ''} aria-pressed={props.view === 'arbol'} onClick={() => props.onChange('arbol')}>
        Árbol
      </button>
    </div>
  );
}
