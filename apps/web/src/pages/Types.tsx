import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage, TRACKING_NAMES, type ContainerType, type ContentType, type LocationType, type Tracking } from '../api';

const letters = (v: string, max: number) => v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, max);

/**
 * Tipos de ubicación y de contenedor: se crean y se editan. Cada tipo tiene un
 * prefijo con el que se codifica lo de ese tipo (EST03, CAJ-000014).
 */
export function TypesPage() {
  const [locationTypes, setLocationTypes] = useState<LocationType[]>([]);
  const [containerTypes, setContainerTypes] = useState<ContainerType[]>([]);
  const [contentTypes, setContentTypes] = useState<ContentType[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, c, k] = await Promise.all([api.locationTypes(), api.containerTypes(), api.contentTypes()]);
      setLocationTypes(l.types);
      setContainerTypes(c.types);
      setContentTypes(k.types);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<string>) => {
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      setEditing(null);
      await load();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  return (
    <>
      <nav className="crumbs">
        <a href="#/inicio">Inicio</a>
        <span>
          <i>›</i>
          <strong>Tipos</strong>
        </span>
      </nav>
      <div className="page-head">
        <div>
          <h2>Tipos</h2>
          <p className="muted nomargin">
            Ubicaciones, contenedores y contenidos: cada tipo tiene un prefijo con el que se codifica todo lo de ese tipo. El contenido va
            siempre en un contenedor o en una ubicación que guarde contenido directamente (un armario, una cajonera).
          </p>
        </div>
      </div>
      {notice && <p className="alert alert-ok">{notice}</p>}
      {error && <p className="alert alert-error">{error}</p>}

      <section>
        <h3>Tipos de ubicación</h3>
        <p className="muted">
          Dentro de otra ubicación, el código es el de la superior, el prefijo del tipo y un número:{' '}
          <span className="mono">ALM-A-PAS01-EST03-NIV02</span>. Las zonas de primer nivel tienen código libre.
        </p>
        <div className="table-wrap card">
          <table className="types-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Prefijo</th>
                <th>Qué guarda</th>
                <th>Contenedores que admite</th>
                <th className="num">Ubicaciones</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {locationTypes.map((t) =>
                editing === `l:${t.code}` ? (
                  <TypeEditRow
                    key={t.code}
                    kind="location"
                    name={t.name}
                    prefix={t.codePrefix}
                    active={t.active}
                    count={t.locationCount}
                    holdsContent={t.holdsContent}
                    allowed={t.allowedContainerTypes}
                    containerTypes={containerTypes}
                    onCancel={() => setEditing(null)}
                    onSave={(v) =>
                      run(async () => {
                        const r = await api.updateLocationType(t.code, v);
                        return r.recoded
                          ? `Tipo guardado. Se han recodificado ${r.recoded} ubicaciones: sus etiquetas siguen funcionando, pero conviene reimprimirlas.`
                          : 'Tipo guardado';
                      })
                    }
                  />
                ) : (
                  <tr key={t.code} className={t.active ? undefined : 'row-off'}>
                    <td>{t.name}</td>
                    <td className="mono">{t.codePrefix}01</td>
                    <td>{t.holdsContent ? <strong>Contenido directamente</strong> : 'Solo contenedores'}</td>
                    <td>
                      {t.allowedContainerTypes.length === 0
                        ? <span className="muted">Cualquiera</span>
                        : t.allowedContainerTypes.map((c) => containerTypes.find((x) => x.code === c)?.name ?? c).join(', ')}
                    </td>
                    <td className="num">{t.locationCount}</td>
                    <td>{t.active ? <span className="badge badge-ok">Activo</span> : <span className="badge badge-off">Desactivado</span>}</td>
                    <td className="row-actions">
                      <button className="btn btn-small" onClick={() => { setNotice(null); setEditing(`l:${t.code}`); }}>
                        Editar
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
        <NewType
          kind="location"
          onCreate={(v) => run(async () => {
            await api.createLocationType({ name: v.name, codePrefix: v.prefix, holdsContent: v.holdsContent });
            return `Tipo de ubicación creado: ${v.name} (${v.prefix}01, ${v.prefix}02…)`;
          })}
        />
      </section>

      <section>
        <h3>Tipos de contenedor</h3>
        <p className="muted">
          Cada contenedor recibe el prefijo de su tipo y un número correlativo: <span className="mono">CAJ-000014</span>.
        </p>
        <div className="table-wrap card">
          <table className="types-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Prefijo</th>
                <th>Política por defecto</th>
                <th className="num">Contenedores</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {containerTypes.map((t) =>
                editing === `c:${t.code}` ? (
                  <TypeEditRow
                    key={t.code}
                    kind="container"
                    name={t.name}
                    prefix={t.codePrefix}
                    policy={t.defaultReusePolicy}
                    active={t.active}
                    count={t.containerCount}
                    onCancel={() => setEditing(null)}
                    onSave={(v) =>
                      run(async () => {
                        const r = await api.updateContainerType(t.code, v);
                        return r.recoded
                          ? `Tipo guardado. Se han recodificado ${r.recoded} contenedores: sus etiquetas siguen funcionando, pero conviene reimprimirlas.`
                          : 'Tipo guardado';
                      })
                    }
                  />
                ) : (
                  <tr key={t.code} className={t.active ? undefined : 'row-off'}>
                    <td>{t.name}</td>
                    <td className="mono">{t.codePrefix}-000001</td>
                    <td>{t.defaultReusePolicy === 'DISPOSABLE' ? 'Desechable' : 'Reutilizable'}</td>
                    <td className="num">{t.containerCount}</td>
                    <td>{t.active ? <span className="badge badge-ok">Activo</span> : <span className="badge badge-off">Desactivado</span>}</td>
                    <td className="row-actions">
                      <button className="btn btn-small" onClick={() => { setNotice(null); setEditing(`c:${t.code}`); }}>
                        Editar
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
        <NewType
          kind="container"
          onCreate={(v) => run(async () => {
            await api.createContainerType({ name: v.name, codePrefix: v.prefix, defaultReusePolicy: v.policy ?? 'REUSABLE' });
            return `Tipo de contenedor creado: ${v.name} (${v.prefix}-000001…)`;
          })}
        />
      </section>

      <section>
        <h3>Tipos de contenido</h3>
        <p className="muted">
          Lo que se guarda en el almacén. Cada contenido recibe el prefijo de su tipo y un número: <span className="mono">HER-000012</span>. Al
          dar de alta uno, el tipo propone cómo se cuenta y si se presta.
        </p>
        <div className="table-wrap card">
          <table className="types-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Prefijo</th>
                <th>Se lleva</th>
                <th>Se cuenta</th>
                <th>Se presta</th>
                <th className="num">Contenidos</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {contentTypes.map((t) =>
                editing === `k:${t.code}` ? (
                  <TypeEditRow
                    key={t.code}
                    kind="content"
                    name={t.name}
                    prefix={t.codePrefix}
                    tracking={t.defaultTracking}
                    loanable={t.defaultLoanable}
                    unitTracked={t.unitTracked}
                    active={t.active}
                    count={t.contentCount}
                    onCancel={() => setEditing(null)}
                    onSave={(v) =>
                      run(async () => {
                        const r = await api.updateContentType(t.code, {
                          name: v.name, codePrefix: v.codePrefix, active: v.active, defaultTracking: v.defaultTracking, defaultLoanable: v.defaultLoanable, unitTracked: v.unitTracked,
                        });
                        return r.recoded ? `Tipo guardado. Se han recodificado ${r.recoded} contenidos.` : 'Tipo guardado';
                      })
                    }
                  />
                ) : (
                  <tr key={t.code} className={t.active ? undefined : 'row-off'}>
                    <td>{t.name}</td>
                    <td className="mono">{t.codePrefix}-000001</td>
                    <td>{t.unitTracked ? <strong>Por unidad</strong> : 'Por cantidad'}</td>
                    <td>{t.unitTracked ? '—' : TRACKING_NAMES[t.defaultTracking]}</td>
                    <td>{t.defaultLoanable ? 'Sí' : 'No'}</td>
                    <td className="num">{t.contentCount}</td>
                    <td>{t.active ? <span className="badge badge-ok">Activo</span> : <span className="badge badge-off">Desactivado</span>}</td>
                    <td className="row-actions">
                      <button className="btn btn-small" onClick={() => { setNotice(null); setEditing(`k:${t.code}`); }}>
                        Editar
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
        <NewType
          kind="content"
          onCreate={(v) => run(async () => {
            await api.createContentType({ name: v.name, codePrefix: v.prefix, defaultTracking: v.tracking, defaultLoanable: v.loanable, unitTracked: v.unitTracked });
            return `Tipo de contenido creado: ${v.name} (${v.prefix}-000001…)`;
          })}
        />
      </section>
    </>
  );
}

type TypeValues = {
  name: string; codePrefix: string; active: boolean; defaultReusePolicy?: string; defaultTracking?: Tracking; defaultLoanable?: boolean;
  unitTracked?: boolean; holdsContent?: boolean; allowedContainerTypes?: string[];
};
type Kind = 'location' | 'container' | 'content';

function TypeEditRow(props: {
  kind: Kind;
  name: string;
  prefix: string;
  policy?: string;
  tracking?: Tracking;
  loanable?: boolean;
  unitTracked?: boolean;
  holdsContent?: boolean;
  allowed?: string[];
  containerTypes?: ContainerType[];
  active: boolean;
  count: number;
  onCancel: () => void;
  onSave: (v: TypeValues) => Promise<boolean>;
}) {
  const [name, setName] = useState(props.name);
  const [prefix, setPrefix] = useState(props.prefix);
  const [policy, setPolicy] = useState(props.policy ?? 'REUSABLE');
  const [tracking, setTracking] = useState<Tracking>(props.tracking ?? 'EXACT');
  const [loanable, setLoanable] = useState(props.loanable ?? false);
  const [unitTracked, setUnitTracked] = useState(props.unitTracked ?? false);
  const [holds, setHolds] = useState(props.holdsContent ?? false);
  const [allowed, setAllowed] = useState<string[]>(props.allowed ?? []);
  const [active, setActive] = useState(props.active);
  const [busy, setBusy] = useState(false);
  const max = props.kind === 'location' ? 6 : 5;
  const min = props.kind === 'location' ? 1 : 2;
  const changedPrefix = prefix !== props.prefix;
  const noun = props.kind === 'location' ? 'ubicaciones' : props.kind === 'container' ? 'contenedores' : 'contenidos con código automático';

  const save = async () => {
    if (changedPrefix && props.count > 0 &&
      !window.confirm(`Al cambiar el prefijo de ${props.prefix} a ${prefix} se recodificarán las ${props.count} ${noun} de este tipo${props.kind === 'location' ? ' y las que llevan dentro' : ''}. Sus etiquetas seguirán funcionando, pero mostrarán el código anterior. ¿Seguir?`)) {
      return;
    }
    setBusy(true);
    await props.onSave({
      name: name.trim(), codePrefix: prefix, active,
      ...(props.kind === 'container' ? { defaultReusePolicy: policy } : {}),
      ...(props.kind === 'content' ? { defaultTracking: tracking, defaultLoanable: loanable, unitTracked } : {}),
      ...(props.kind === 'location' ? { holdsContent: holds, allowedContainerTypes: allowed } : {}),
    });
    setBusy(false);
  };

  return (
    <tr className="row-editing">
      <td>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Nombre" />
      </td>
      <td>
        <input className="mono prefix-input" value={prefix} onChange={(e) => setPrefix(letters(e.target.value, max))} aria-label="Prefijo" />
        {changedPrefix && props.count > 0 && <div className="small low">Recodificará {props.count} {noun}</div>}
      </td>
      {props.kind === 'location' && (
        <>
          <td>
            <select value={holds ? 'yes' : 'no'} onChange={(e) => setHolds(e.target.value === 'yes')} aria-label="Qué guarda">
              <option value="no">Solo contenedores</option>
              <option value="yes">Contenido directamente</option>
            </select>
          </td>
          <td>
            <div className="pchips tight">
              {(props.containerTypes ?? []).filter((c) => c.active || allowed.includes(c.code)).map((c) => (
                <button
                  type="button"
                  key={c.code}
                  className={`pchip ${allowed.includes(c.code) ? 'on' : ''}`}
                  onClick={() => setAllowed(allowed.includes(c.code) ? allowed.filter((x) => x !== c.code) : [...allowed, c.code])}
                >
                  {c.name}
                </button>
              ))}
            </div>
            <small className="muted">{allowed.length ? 'Solo los marcados' : 'Ninguno marcado: admite cualquiera'}</small>
          </td>
        </>
      )}
      {props.kind === 'container' && (
        <td>
          <select value={policy} onChange={(e) => setPolicy(e.target.value)} aria-label="Política por defecto">
            <option value="REUSABLE">Reutilizable</option>
            <option value="DISPOSABLE">Desechable</option>
          </select>
        </td>
      )}
      {props.kind === 'content' && (
        <>
          <td>
            <select value={unitTracked ? 'unit' : 'qty'} onChange={(e) => setUnitTracked(e.target.value === 'unit')} aria-label="Cómo se lleva">
              <option value="qty">Por cantidad</option>
              <option value="unit">Por unidad</option>
            </select>
          </td>
          <td>
            <select value={tracking} disabled={unitTracked} onChange={(e) => setTracking(e.target.value as Tracking)} aria-label="Cómo se cuenta">
              {(Object.keys(TRACKING_NAMES) as Tracking[]).map((k) => <option key={k} value={k}>{TRACKING_NAMES[k]}</option>)}
            </select>
          </td>
          <td>
            <label className="check nomargin">
              <input type="checkbox" checked={loanable} onChange={(e) => setLoanable(e.target.checked)} />
              <span>Se presta</span>
            </label>
          </td>
        </>
      )}
      <td className="num">{props.count}</td>
      <td>
        <label className="check nomargin">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>Activo</span>
        </label>
      </td>
      <td className="row-actions">
        <button className="btn btn-small" onClick={props.onCancel} disabled={busy}>
          Cancelar
        </button>
        <button className="btn btn-small btn-primary" onClick={save} disabled={busy || !name.trim() || prefix.length < min}>
          Guardar
        </button>
      </td>
    </tr>
  );
}

function NewType(props: {
  kind: Kind;
  onCreate: (v: { name: string; prefix: string; policy?: string; tracking?: Tracking; loanable?: boolean; unitTracked?: boolean; holdsContent?: boolean }) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [policy, setPolicy] = useState('REUSABLE');
  const [tracking, setTracking] = useState<Tracking>('EXACT');
  const [loanable, setLoanable] = useState(false);
  const [unitTracked, setUnitTracked] = useState(false);
  const [holdsContent, setHoldsContent] = useState(false);
  const max = props.kind === 'location' ? 6 : 5;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await props.onCreate({ name: name.trim(), prefix, policy, tracking, loanable, unitTracked, holdsContent })) {
      setName('');
      setPrefix('');
    }
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h4 className="nomargin">Nuevo tipo de {props.kind === 'location' ? 'ubicación' : props.kind === 'container' ? 'contenedor' : 'contenido'}</h4>
      <div className="grid-2">
        <label className="field">
          <span>Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder={props.kind === 'location' ? 'Balda' : props.kind === 'container' ? 'Jaula' : 'Repuesto'} />
        </label>
        <label className="field">
          <span>Prefijo</span>
          <input
            className="mono"
            value={prefix}
            onChange={(e) => setPrefix(letters(e.target.value, max))}
            required
            minLength={props.kind === 'location' ? 1 : 2}
            placeholder={props.kind === 'location' ? 'BAL' : props.kind === 'container' ? 'JAU' : 'REP'}
          />
          <small className="muted">
            {props.kind === 'location'
              ? `Letras, hasta 6. Con BAL, las ubicaciones de este tipo serán BAL01, BAL02…`
              : props.kind === 'container'
                ? `De 2 a 5 letras. Con JAU, los contenedores serán JAU-000001, JAU-000002…`
                : `De 2 a 5 letras, distinto de los de contenedor. Con REP, serán REP-000001, REP-000002…`}
          </small>
        </label>
        {props.kind === 'location' && (
          <label className="field">
            <span>Qué guarda</span>
            <select value={holdsContent ? 'yes' : 'no'} onChange={(e) => setHoldsContent(e.target.value === 'yes')}>
              <option value="no">Solo contenedores (estanterías, niveles, zonas…)</option>
              <option value="yes">Contenido directamente (armarios, cajoneras…)</option>
            </select>
          </label>
        )}
        {props.kind === 'container' && (
          <label className="field">
            <span>Política por defecto</span>
            <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
              <option value="REUSABLE">Reutilizable</option>
              <option value="DISPOSABLE">Desechable</option>
            </select>
          </label>
        )}
        {props.kind === 'content' && (
          <>
            <label className="field">
              <span>Cómo se lleva</span>
              <select value={unitTracked ? 'unit' : 'qty'} onChange={(e) => setUnitTracked(e.target.value === 'unit')}>
                <option value="qty">Por cantidad (materiales, consumibles)</option>
                <option value="unit">Por unidad: cada una con su código y su QR</option>
              </select>
            </label>
            <label className="field">
              <span>Cómo se cuenta, por defecto</span>
              <select value={tracking} onChange={(e) => setTracking(e.target.value as Tracking)}>
                {(Object.keys(TRACKING_NAMES) as Tracking[]).map((k) => <option key={k} value={k}>{TRACKING_NAMES[k]}</option>)}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={loanable} onChange={(e) => setLoanable(e.target.checked)} />
              <span>Se presta (herramientas y equipos)</span>
            </label>
          </>
        )}
      </div>
      <div className="actions">
        <button className="btn btn-primary">Añadir tipo</button>
      </div>
    </form>
  );
}
