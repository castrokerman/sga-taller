import { useMemo, useState, type ReactNode } from 'react';

/**
 * Orden y filtros para cualquier lista: ubicaciones, contenedores, usuarios…
 * Todo ocurre en el navegador, sobre la lista ya cargada.
 */

export interface SortOption<T> {
  key: string;
  label: string;
  value: (item: T) => string | number | null | undefined;
  /** Sentido al elegirlo: los números y fechas suelen interesar de mayor a menor. */
  defaultDir?: 'asc' | 'desc';
}

export interface FilterOption<T> {
  key: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  test: (item: T, value: string) => boolean;
}

export interface ListConfig<T> {
  /** Clave para recordar el orden elegido en este dispositivo. */
  storageKey: string;
  /** Nombre en plural para el recuento: «3 de 14 contenedores». */
  noun: string;
  /** Textos en los que busca la casilla de filtrar. */
  text: (item: T) => Array<string | null | undefined>;
  sorts: Array<SortOption<T>>;
  filters?: Array<FilterOption<T>>;
  placeholder?: string;
}

type Dir = 'asc' | 'desc';

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Minúsculas y sin tildes, para buscar sin que importen. */
export const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Opciones de un filtro sacadas de los valores que aparecen en la lista. */
export function optionsFrom<T>(items: T[], value: (item: T) => string | null | undefined) {
  const seen = new Set<string>();
  for (const item of items) {
    const v = value(item);
    if (v) seen.add(v);
  }
  return [...seen].sort(collator.compare).map((v) => ({ value: v, label: v }));
}

function loadSort(key: string): { key: string; dir: Dir } | null {
  try {
    const raw = window.localStorage.getItem(`ada.orden.${key}`);
    return raw ? (JSON.parse(raw) as { key: string; dir: Dir }) : null;
  } catch {
    return null;
  }
}

function saveSort(key: string, value: { key: string; dir: Dir }) {
  try {
    window.localStorage.setItem(`ada.orden.${key}`, JSON.stringify(value));
  } catch {
    /* sin almacenamiento local: el orden vale solo mientras la pantalla está abierta */
  }
}

const empty = (v: unknown) => v === null || v === undefined || v === '';

export function useListControls<T>(items: T[], config: ListConfig<T>) {
  const first = config.sorts[0]!;
  const [sort, setSort] = useState<{ key: string; dir: Dir }>(() => {
    const saved = loadSort(config.storageKey);
    return saved && config.sorts.some((s) => s.key === saved.key) ? saved : { key: first.key, dir: first.defaultDir ?? 'asc' };
  });
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<Record<string, string>>({});
  const [panelOpen, setPanelOpen] = useState(false);
  const filters = config.filters ?? [];

  const q = query.trim();
  const visible = useMemo(() => {
    const nq = normalize(q);
    const option = config.sorts.find((s) => s.key === sort.key) ?? first;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return items
      .filter((item) => !nq || config.text(item).some((t) => t && normalize(t).includes(nq)))
      .filter((item) => filters.every((f) => !active[f.key] || f.test(item, active[f.key]!)))
      .sort((a, b) => {
        const va = option.value(a);
        const vb = option.value(b);
        // Los vacíos van siempre al final, sea cual sea el sentido.
        if (empty(va)) return empty(vb) ? 0 : 1;
        if (empty(vb)) return -1;
        const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : collator.compare(String(va), String(vb));
        return cmp * factor;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, q, active, sort]);

  const chooseSort = (key: string) => {
    const option = config.sorts.find((s) => s.key === key)!;
    const next = { key, dir: option.defaultDir ?? ('asc' as Dir) };
    setSort(next);
    saveSort(config.storageKey, next);
  };
  const flipDir = () => {
    const next = { key: sort.key, dir: sort.dir === 'asc' ? ('desc' as Dir) : ('asc' as Dir) };
    setSort(next);
    saveSort(config.storageKey, next);
  };

  const activeFilters = filters.filter((f) => active[f.key]);
  const anyFilter = activeFilters.length > 0 || q !== '';
  const clear = () => {
    setQuery('');
    setActive({});
  };
  const unset = (key: string) => setActive({ ...active, [key]: '' });

  const bar: ReactNode = (
    <>
      <div className="listbar">
        <div className="search">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={config.placeholder ?? 'Filtrar por código, nombre o descripción'}
            aria-label={`Filtrar ${config.noun}`}
          />
        </div>
        <div className="sortgroup">
          <label htmlFor={`orden-${config.storageKey}`}>Ordenar por</label>
          <select id={`orden-${config.storageKey}`} value={sort.key} onChange={(e) => chooseSort(e.target.value)}>
            {config.sorts.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn dirbtn"
            onClick={flipDir}
            title={sort.dir === 'asc' ? 'Ascendente. Pulsa para invertir el orden' : 'Descendente. Pulsa para invertir el orden'}
            aria-label={sort.dir === 'asc' ? 'Orden ascendente; pulsa para invertir' : 'Orden descendente; pulsa para invertir'}
          >
            {sort.dir === 'asc' ? '↑' : '↓'}
          </button>
        </div>
        {filters.length > 0 && (
          <button
            type="button"
            className={`btn ${panelOpen || activeFilters.length ? 'on' : ''}`}
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen(!panelOpen)}
          >
            Filtros{activeFilters.length ? ` · ${activeFilters.length}` : ''}
          </button>
        )}
      </div>

      {panelOpen && filters.length > 0 && (
        <div className="card filters">
          {filters.map((f) => (
            <label key={f.key} className="field">
              <span>{f.label}</span>
              <select value={active[f.key] ?? ''} onChange={(e) => setActive({ ...active, [f.key]: e.target.value })}>
                <option value="">Todos</option>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}

      {anyFilter && (
        <div className="chips">
          {q && (
            <span className="chip">
              Texto: {q}
              <button type="button" aria-label="Quitar el texto" onClick={() => setQuery('')}>
                ✕
              </button>
            </span>
          )}
          {activeFilters.map((f) => (
            <span key={f.key} className="chip">
              {f.label}: {f.options.find((o) => o.value === active[f.key])?.label ?? active[f.key]}
              <button type="button" aria-label={`Quitar el filtro ${f.label}`} onClick={() => unset(f.key)}>
                ✕
              </button>
            </span>
          ))}
          <button type="button" className="linkbtn" onClick={clear}>
            Quitar filtros
          </button>
          <span className="count">
            {visible.length} de {items.length} {config.noun}
          </span>
        </div>
      )}
    </>
  );

  return { bar, visible, query: q, filtered: anyFilter };
}

/** Resalta en el texto lo que coincide con la búsqueda, sin distinguir tildes ni mayúsculas. */
export function Highlight({ text, query }: { text: string | null | undefined; query?: string }) {
  if (!text) return null;
  const q = normalize((query ?? '').trim());
  if (!q) return <>{text}</>;
  // normalize() conserva la longitud de cada letra salvo las tildes; se recorre letra a letra.
  const letters = [...text];
  const plain = letters.map((ch) => normalize(ch)).join('');
  if (plain.length !== letters.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let from = 0;
  let at = plain.indexOf(q);
  while (at !== -1) {
    if (at > from) parts.push(letters.slice(from, at).join(''));
    parts.push(<mark key={at}>{letters.slice(at, at + q.length).join('')}</mark>);
    from = at + q.length;
    at = plain.indexOf(q, from);
  }
  if (from < letters.length) parts.push(letters.slice(from).join(''));
  return <>{parts}</>;
}
