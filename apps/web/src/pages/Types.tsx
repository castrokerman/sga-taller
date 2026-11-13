import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage, type ContainerType, type LocationType } from '../api';

/** Administración de los tipos de ubicación y de contenedor. */
export function TypesPage() {
  const [locationTypes, setLocationTypes] = useState<LocationType[]>([]);
  const [containerTypes, setContainerTypes] = useState<ContainerType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, c] = await Promise.all([api.locationTypes(), api.containerTypes()]);
      setLocationTypes(l.types);
      setContainerTypes(c.types);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const [lCode, setLCode] = useState('');
  const [lName, setLName] = useState('');
  const [cCode, setCCode] = useState('');
  const [cName, setCName] = useState('');
  const [cPrefix, setCPrefix] = useState('');
  const [cPolicy, setCPolicy] = useState('REUSABLE');

  const run = async (action: () => Promise<unknown>, text: string) => {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(text);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const addLocationType = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.createLocationType({ code: lCode, name: lName });
      setLCode('');
      setLName('');
    }, `Tipo de ubicación creado: ${lName}`);
  };

  const addContainerType = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.createContainerType({ code: cCode, name: cName, codePrefix: cPrefix, defaultReusePolicy: cPolicy });
      setCCode('');
      setCName('');
      setCPrefix('');
    }, `Tipo de contenedor creado: ${cName}`);
  };

  const upper = (v: string) => v.toUpperCase().replace(/[^A-Z0-9_]/g, '');

  return (
    <>
      <div className="page-head">
        <a className="btn" href="#/inicio">
          ← Inicio
        </a>
        <h2>Tipos</h2>
      </div>
      {notice && <p className="alert alert-ok">{notice}</p>}
      {error && <p className="alert alert-error">{error}</p>}

      <section>
        <h3>Tipos de ubicación</h3>
        <p className="tags">
          {locationTypes.map((t) => (
            <span key={t.code} className="tag">
              {t.name}
            </span>
          ))}
        </p>
        <form className="card form" onSubmit={addLocationType}>
          <div className="grid-2">
            <label className="field">
              <span>Código</span>
              <input value={lCode} onChange={(e) => setLCode(upper(e.target.value))} required pattern="[A-Z][A-Z0-9_]{1,29}" />
              <small className="muted">Mayúsculas, sin espacios. Ejemplo: MURO.</small>
            </label>
            <label className="field">
              <span>Nombre</span>
              <input value={lName} onChange={(e) => setLName(e.target.value)} required maxLength={60} />
            </label>
          </div>
          <div className="actions">
            <button className="btn btn-primary">Añadir tipo de ubicación</button>
          </div>
        </form>
      </section>

      <section>
        <h3>Tipos de contenedor</h3>
        <p className="tags">
          {containerTypes.map((t) => (
            <span key={t.code} className="tag">
              {t.name} · {t.codePrefix}
            </span>
          ))}
        </p>
        <form className="card form" onSubmit={addContainerType}>
          <div className="grid-2">
            <label className="field">
              <span>Código</span>
              <input value={cCode} onChange={(e) => setCCode(upper(e.target.value))} required pattern="[A-Z][A-Z0-9_]{1,29}" />
            </label>
            <label className="field">
              <span>Nombre</span>
              <input value={cName} onChange={(e) => setCName(e.target.value)} required maxLength={60} />
            </label>
            <label className="field">
              <span>Prefijo de los códigos</span>
              <input value={cPrefix} onChange={(e) => setCPrefix(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5))} required pattern="[A-Z]{2,5}" />
              <small className="muted">De 2 a 5 letras. Con JAU, los códigos serán JAU-000001, JAU-000002…</small>
            </label>
            <label className="field">
              <span>Política por defecto</span>
              <select value={cPolicy} onChange={(e) => setCPolicy(e.target.value)}>
                <option value="REUSABLE">Reutilizable</option>
                <option value="DISPOSABLE">Desechable</option>
              </select>
            </label>
          </div>
          <div className="actions">
            <button className="btn btn-primary">Añadir tipo de contenedor</button>
          </div>
        </form>
      </section>
    </>
  );
}
