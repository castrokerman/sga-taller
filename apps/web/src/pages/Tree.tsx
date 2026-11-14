import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage, type TreeContainer, type TreeLocation, type User } from '../api';
import { ViewSwitch } from '../components/Common';
import { Highlight, normalize } from '../components/ListControls';
import { navigate } from '../router';

/** Un elemento del árbol: una ubicación o un contenedor. */
interface Node {
  key: string;
  kind: 'location' | 'container';
  id: string;
  code: string;
  label: string;
  typeName: string;
  meta: string;
  over: boolean;
  children: Node[];
}

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
const byCode = (a: Node, b: Node) =>
  a.kind === b.kind ? collator.compare(a.code, b.code) : a.kind === 'location' ? -1 : 1;

function buildTree(locations: TreeLocation[], containers: TreeContainer[], withContainers: boolean): Node[] {
  const nodes = new Map<string, Node>();
  for (const l of locations) {
    const parts = [];
    if (l.maxCapacity !== null) parts.push(`${l.containerCount} de ${l.maxCapacity}`);
    else if (l.childCount === 0 && l.containerCount === 0) parts.push('Vacía');
    nodes.set(`l:${l.id}`, {
      key: `l:${l.id}`, kind: 'location', id: l.id, code: l.code, label: l.name, typeName: l.typeName,
      meta: parts.join(' · '), over: l.maxCapacity !== null && l.containerCount > l.maxCapacity, children: [],
    });
  }
  if (withContainers) {
    for (const c of containers) {
      nodes.set(`c:${c.id}`, {
        key: `c:${c.id}`, kind: 'container', id: c.id, code: c.code, label: c.description ?? '', typeName: c.typeName,
        meta: '', over: false, children: [],
      });
    }
  }
  const roots: Node[] = [];
  for (const l of locations) {
    const n = nodes.get(`l:${l.id}`)!;
    const parent = l.parentId ? nodes.get(`l:${l.parentId}`) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  if (withContainers) {
    for (const c of containers) {
      const n = nodes.get(`c:${c.id}`)!;
      const parent = c.parentContainerId ? nodes.get(`c:${c.parentContainerId}`) : c.locationId ? nodes.get(`l:${c.locationId}`) : undefined;
      parent?.children.push(n);
    }
  }
  const sortAll = (list: Node[]) => {
    list.sort(byCode);
    list.forEach((n) => sortAll(n.children));
  };
  sortAll(roots);
  return roots;
}

/**
 * Si hay búsqueda, deja solo lo que coincide y el camino hasta ello.
 * Devuelve el árbol podado, los nodos que hay que desplegar y cuántos coinciden.
 */
function prune(nodes: Node[], query: string) {
  const q = normalize(query);
  const open = new Set<string>();
  let hits = 0;
  const walk = (list: Node[]): Node[] =>
    list.flatMap((n) => {
      const match = normalize(n.code).includes(q) || normalize(n.label).includes(q);
      const kids = walk(n.children);
      if (match) hits++;
      if (kids.length) open.add(n.key);
      if (!match && kids.length === 0) return [];
      return [{ ...n, children: match && kids.length === 0 ? [] : kids }];
    });
  return { nodes: walk(nodes), open, hits };
}

const allKeys = (nodes: Node[]): string[] => nodes.flatMap((n) => (n.children.length ? [n.key, ...allKeys(n.children)] : []));

function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v === 'true';
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* sin almacenamiento local */
  }
}

export function WarehouseTree({ user, onList }: { user: User; onList: () => void }) {
  const [data, setData] = useState<{ locations: TreeLocation[]; containers: TreeContainer[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const canSeeContainers = user.permissions.includes('container.read');
  const [withContainers, setWithContainers] = useState(() => canSeeContainers && readPref('sga.arbol-contenedores', true));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.tree().then((d) => {
      setData(d);
      // Al abrir, se ven desplegadas las zonas: el primer nivel bajo cada raíz.
      setExpanded(new Set(d.locations.filter((l) => !l.parentId).map((l) => `l:${l.id}`)));
    }).catch((e) => setError(errorMessage(e)));
  }, []);

  const tree = useMemo(() => (data ? buildTree(data.locations, data.containers, withContainers) : []), [data, withContainers]);
  const q = query.trim();
  const searching = q.length > 0;
  const view = useMemo(() => (searching ? prune(tree, q) : null), [tree, q, searching]);
  const shown = view ? view.nodes : tree;
  const isOpen = (key: string) => (view ? view.open.has(key) : expanded.has(key));

  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  };

  const toggleContainers = (v: boolean) => {
    setWithContainers(v);
    writePref('sga.arbol-contenedores', v);
  };

  const render = (list: Node[]) => (
    <ul>
      {list.map((n) => {
        const hasKids = n.children.length > 0;
        const open = hasKids && isOpen(n.key);
        const hit = searching && (normalize(n.code).includes(normalize(q)) || normalize(n.label).includes(normalize(q)));
        return (
          <li key={n.key}>
            <div
              className={`node ${n.kind === 'container' ? 'cont' : ''} ${hit ? 'hit' : ''}`}
              role="link"
              tabIndex={0}
              onClick={() => navigate(n.kind === 'location' ? `almacen/${n.id}` : `contenedor/${n.id}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') navigate(n.kind === 'location' ? `almacen/${n.id}` : `contenedor/${n.id}`);
              }}
            >
              <button
                className={`tog ${hasKids ? '' : 'leaf'}`}
                aria-label={open ? `Plegar ${n.code}` : `Desplegar ${n.code}`}
                aria-expanded={hasKids ? open : undefined}
                disabled={!hasKids || searching}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(n.key);
                }}
              >
                {open ? '▾' : '▸'}
              </button>
              <span className="icon" aria-hidden="true">{n.kind === 'location' ? '▦' : '▣'}</span>
              <span className="ncode"><Highlight text={n.code} query={q} /></span>
              <span className="nname"><Highlight text={n.label} query={q} /></span>
              <span className="nmeta">
                <span className="tag">{n.typeName}</span>
                {n.meta && <span className={n.over ? 'over' : undefined}>{n.meta}</span>}
              </span>
            </div>
            {open && render(n.children)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      <div className="page-head">
        <h2>Almacén</h2>
        <ViewSwitch view="arbol" onChange={(v) => v === 'lista' && onList()} />
      </div>

      <div className="treebar">
        <div className="listbar">
          <div className="search">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar en el árbol: código o nombre"
              aria-label="Buscar en el árbol"
            />
          </div>
        </div>
        {canSeeContainers && (
          <label className="check">
            <input type="checkbox" checked={withContainers} onChange={(e) => toggleContainers(e.target.checked)} />
            <span>
              <strong>Mostrar contenedores</strong>
            </span>
          </label>
        )}
        <button className="btn" disabled={searching} onClick={() => setExpanded(new Set(allKeys(tree)))}>
          Desplegar todo
        </button>
        <button className="btn" disabled={searching} onClick={() => setExpanded(new Set())}>
          Plegar todo
        </button>
      </div>

      {searching && view && (
        <p className="muted">
          {view.hits === 0
            ? 'Nada coincide con la búsqueda.'
            : `${view.hits} resultado${view.hits === 1 ? '' : 's'} · se muestra el camino hasta cada uno`}
        </p>
      )}
      {!searching && (
        <div className="legend">
          <span>▦ Ubicación</span>
          {withContainers && <span className="legend-cont">▣ Contenedor</span>}
          <span>Pulsa una línea para abrir su ficha</span>
        </div>
      )}

      {error && <p className="alert alert-error">{error}</p>}
      {!data && !error && <p className="muted">Cargando…</p>}
      {data && tree.length === 0 && <p className="alert alert-info">El almacén está vacío. Pasa a la vista de lista para crear las primeras ubicaciones.</p>}
      {shown.length > 0 && <div className="card tree">{render(shown)}</div>}
    </>
  );
}
