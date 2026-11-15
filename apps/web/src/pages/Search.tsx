import { useEffect, useState } from 'react';
import { api, errorMessage, formatQty, photoUrl, type SearchResult } from '../api';
import { Highlight } from '../components/ListControls';
import { navigate } from '../router';

const KEY = 'sga.buscador-ultimo';

/** Buscador general: escribe palabras y salen materiales, contenedores y ubicaciones con dónde están. */
export function SearchPage() {
  const [q, setQ] = useState(() => {
    try {
      return window.sessionStorage.getItem(KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [res, setRes] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(KEY, q);
    } catch {
      /* sin almacenamiento */
    }
    const text = q.trim();
    if (text.length < 2) {
      setRes(null);
      return;
    }
    // Busca al dejar de escribir.
    const t = window.setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        setRes(await api.search(text));
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const total = res ? res.materials.length + res.containers.length + res.locations.length : 0;
  const query = q.trim();

  return (
    <>
      <nav className="crumbs">
        <a href="#/inicio">Inicio</a>
        <span>
          <i>›</i>
          <strong>Buscador</strong>
        </span>
      </nav>
      <div className="page-head">
        <div>
          <h2>Buscador</h2>
          <p className="muted nomargin">Escribe una o varias palabras: nombre, referencia, código, fabricante, lote…</p>
        </div>
      </div>
      <div className="listbar">
      <div className="search search-big">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Por ejemplo: tornillo m6 inox"
          autoFocus
          aria-label="Buscar"
        />
      </div>
      </div>
      {error && <p className="alert alert-error">{error}</p>}
      {busy && !res && <p className="muted">Buscando…</p>}
      {res && total === 0 && !busy && <p className="muted">Nada coincide con «{query}». Prueba con menos palabras o con otra forma de escribirlo.</p>}

      {res && res.materials.length > 0 && (
        <section>
          <h3>Materiales <span className="muted small">({res.materials.length})</span></h3>
          <ul className="results">
            {res.materials.map((m) => (
              <li key={m.id}>
                <button className="result" onClick={() => navigate(`material/${m.id}`)}>
                  {m.photoId ? <img className="item-photo" src={photoUrl(m.photoId)} alt="" loading="lazy" /> : <span className="item-photo empty" />}
                  <span className="result-main">
                    <strong><Highlight text={m.description} query={query} /></strong>
                    <span className="muted small">
                      <Highlight text={m.internalRef} query={query} /> · {m.familyName}
                      {m.status === 'OBSOLETE' && ' · de baja'}
                    </span>
                    <span className="where">
                      {m.places.length === 0 ? (
                        <span className="muted">Sin stock en ningún sitio</span>
                      ) : (
                        m.places.slice(0, 4).map((p, i) => (
                          <span key={i} className="where-item">
                            📍 <b className="mono">{p.placeCode}</b>
                            {p.containerId && p.locationCode && <span className="muted"> en {p.locationCode}</span>}
                            {m.quantityTracking !== 'NOT_TRACKED' && <span> · {formatQty(p.quantity, m.unitCode, m.quantityTracking)}</span>}
                          </span>
                        ))
                      )}
                      {m.places.length > 4 && <span className="muted"> y {m.places.length - 4} sitios más</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {res && res.containers.length > 0 && (
        <section>
          <h3>Contenedores <span className="muted small">({res.containers.length})</span></h3>
          <ul className="results">
            {res.containers.map((c) => (
              <li key={c.id}>
                <button className="result" onClick={() => navigate(`contenedor/${c.id}`)}>
                  {c.photoId ? <img className="item-photo" src={photoUrl(c.photoId)} alt="" loading="lazy" /> : <span className="item-photo empty" />}
                  <span className="result-main">
                    <strong className="mono"><Highlight text={c.code} query={query} /></strong>
                    <span className="small">
                      {c.typeName}
                      {c.description && <> · <Highlight text={c.description} query={query} /></>}
                      {c.status !== 'ACTIVE' && ' · retirado'}
                    </span>
                    <span className="where">
                      {c.locationCode ? (
                        <span className="where-item">
                          📍 <b className="mono">{c.locationCode}</b>
                          {c.parentCode && <span className="muted"> dentro de {c.parentCode}</span>}
                        </span>
                      ) : (
                        <span className="muted">Sin ubicación</span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {res && res.locations.length > 0 && (
        <section>
          <h3>Ubicaciones <span className="muted small">({res.locations.length})</span></h3>
          <ul className="results">
            {res.locations.map((l) => (
              <li key={l.id}>
                <button className={`result ${l.active ? '' : 'item-off'}`} onClick={() => navigate(`almacen/${l.id}`)}>
                  {l.photoId ? <img className="item-photo" src={photoUrl(l.photoId)} alt="" loading="lazy" /> : <span className="item-photo empty" />}
                  <span className="result-main">
                    <strong className="mono"><Highlight text={l.code} query={query} /></strong>
                    <span className="small">
                      <Highlight text={l.name} query={query} /> · {l.typeName}
                      {!l.active && ' · desactivada'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
