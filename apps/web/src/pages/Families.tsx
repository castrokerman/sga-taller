import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage, type ContentType, type Family, type Unit, type User } from '../api';

/** Familias de material: las crean y cambian los responsables, con subfamilias. */
export function FamiliesPage({ user }: { user: User }) {
  const [families, setFamilies] = useState<Family[] | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [types, setTypes] = useState<ContentType[]>([]);
  const [editing, setEditing] = useState<{ mode: 'new' | 'sub' | 'edit'; family?: Family; type?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manage = user.permissions.includes('material.manage');

  const load = async () => {
    try {
      const [f, u, t] = await Promise.all([api.families(), api.units(), api.contentTypes()]);
      setFamilies(f.families);
      setUnits(u.units);
      setTypes(t.types);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const done = async (text: string) => {
    setEditing(null);
    await load();
    setNotice(text);
  };

  const act = async (fn: () => Promise<unknown>, text: string) => {
    setNotice(null);
    setError(null);
    try {
      await fn();
      await done(text);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <>
      <nav className="crumbs">
        <a href="#/inicio">Inicio</a>
        <span>
          <i>›</i>
          <a href="#/contenidos">Contenidos</a>
        </span>
        <span>
          <i>›</i>
          <strong>Familias</strong>
        </span>
      </nav>
      <div className="page-head">
        <div>
          <h2>Familias de contenido</h2>
          <p className="muted nomargin">
            El primer nivel son los tipos de contenido; debajo, sus familias y subfamilias. Al registrar un contenido solo se ofrecen las
            familias de su tipo.
          </p>
        </div>
        {manage && (
          <button className="btn btn-primary push-right" onClick={() => { setNotice(null); setEditing({ mode: 'new' }); }}>
            + Nueva familia
          </button>
        )}
      </div>
      {notice && <p className="alert alert-ok">{notice}</p>}
      {error && <p className="alert alert-error">{error}</p>}
      {editing && families && (
        <FamilyForm
          key={`${editing.mode}${editing.family?.id ?? ''}`}
          mode={editing.mode}
          family={editing.family}
          families={families}
          units={units}
          types={types}
          initialType={editing.type}
          onCancel={() => setEditing(null)}
          onDone={done}
        />
      )}

      {families === null ? (
        <p className="muted">Cargando…</p>
      ) : (
        <div className="card famtable">
          <div className="famrow h">
            <span>Nombre</span>
            <span className="hide-m">Unidad habitual</span>
            <span>Contenidos</span>
            <span />
          </div>
          {[...types, ...(families.some((f) => !types.some((t) => t.code === f.contentTypeCode)) ? [{ code: '?', name: 'Otro tipo' } as ContentType] : [])].map((t) => {
            const list = families.filter((f) => (t.code === '?' ? !types.some((x) => x.code === f.contentTypeCode) : f.contentTypeCode === t.code));
            return (
              <div key={t.code} className="famgroup">
                <div className="famrow famtype">
                  <span>
                    <span className="tag tag-type">{t.name}</span>
                    {list.length === 0 && <span className="muted small"> · sin familias: al registrar uno de este tipo se puede elegir cualquiera</span>}
                  </span>
                  <span className="hide-m" />
                  <span>{list.filter((f) => !f.parentId).reduce((n, f) => n + f.materialCount, 0) || ''}</span>
                  <span className="fa">
                    {manage && t.code !== '?' && (
                      <button className="btn btn-small" onClick={() => { setNotice(null); setEditing({ mode: 'new', type: t.code }); }}>
                        + Familia de {t.name.toLowerCase()}
                      </button>
                    )}
                  </span>
                </div>
                {list.map((f) => (
            <div key={f.id} className={`famrow ${f.active ? '' : 'off'}`}>
              <span style={{ paddingLeft: `${f.ancestorIds.length * 1.4}rem` }}>
                {f.parentId ? '↳ ' : ''}
                {f.parentId ? f.name : <b>{f.name}</b>}
                {!f.active && ' (desactivada)'}
              </span>
              <span className="hide-m">{units.find((u) => u.code === f.defaultUnitCode)?.name.toLowerCase() ?? '—'}</span>
              <span>{f.materialCount}</span>
              <span className="fa">
                {manage && f.active && (
                  <>
                    <button className="btn btn-small" onClick={() => { setNotice(null); setEditing({ mode: 'edit', family: f }); }}>
                      Cambiar
                    </button>
                    <button className="btn btn-small" onClick={() => { setNotice(null); setEditing({ mode: 'sub', family: f }); }}>
                      + Subfamilia
                    </button>
                  </>
                )}
                {manage && f.active && (f.materialCount > 0 || f.childCount > 0) && (
                  <button className="btn btn-small" onClick={() => act(() => api.updateFamily(f.id, { active: false }), `${f.name} desactivada`)}>
                    Desactivar
                  </button>
                )}
                {manage && f.materialCount === 0 && f.childCount === 0 && (
                  <button
                    className="btn btn-small btn-danger"
                    onClick={() => window.confirm(`¿Borrar la familia «${f.name}»?`) && act(() => api.deleteFamily(f.id), `${f.name} borrada`)}
                  >
                    Borrar
                  </button>
                )}
                {manage && !f.active && (
                  <button className="btn btn-small" onClick={() => act(() => api.updateFamily(f.id, { active: true }), `${f.name} reactivada`)}>
                    Reactivar
                  </button>
                )}
              </span>
            </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
      <p className="alert alert-info" style={{ marginTop: '1rem' }}>
        Una familia con contenidos no se borra: se desactiva y deja de ofrecerse al dar de alta. Cambiar el nombre o moverla
        no afecta al stock ni al historial.
      </p>
    </>
  );
}

function FamilyForm(props: {
  mode: 'new' | 'sub' | 'edit';
  family?: Family;
  families: Family[];
  units: Unit[];
  types: ContentType[];
  initialType?: string;
  onCancel: () => void;
  onDone: (text: string) => void;
}) {
  const f = props.mode === 'edit' ? props.family : undefined;
  const [type, setType] = useState(f?.contentTypeCode ?? props.initialType ?? props.types[0]?.code ?? 'MATERIAL');
  const [name, setName] = useState(f?.name ?? '');
  const [parentId, setParentId] = useState(props.mode === 'sub' ? props.family!.id : f?.parentId ?? '');
  const [unit, setUnit] = useState(f?.defaultUnitCode ?? (props.mode === 'sub' ? props.family!.defaultUnitCode ?? 'ud' : 'ud'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // No se puede mover una familia dentro de sí misma ni de sus subfamilias.
  const parents = props.families.filter((x) => x.active && (!f || !x.ancestorIds.includes(f.id)));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (f) {
        await api.updateFamily(f.id, { name: name.trim(), parentId: parentId || null, defaultUnitCode: unit || null, ...(parentId ? {} : { contentTypeCode: type }) });
        props.onDone('Familia guardada');
      } else {
        await api.createFamily({ name: name.trim(), parentId: parentId || undefined, defaultUnitCode: unit || undefined, ...(parentId ? {} : { contentTypeCode: type }) });
        props.onDone(`Familia «${name.trim()}» creada`);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={save}>
      <h3>{f ? `Cambiar ${f.name}` : props.mode === 'sub' ? `Nueva subfamilia de ${props.family!.name}` : 'Nueva familia'}</h3>
      <label className="field">
        <span>Nombre</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus />
      </label>
      {!parentId && (
        <label className="field">
          <span>Tipo de contenido</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {props.types.filter((t) => t.active || t.code === type).map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </select>
          {f && f.childCount > 0 && <small className="muted">Sus subfamilias cambian de tipo con ella.</small>}
        </label>
      )}
      <div className="grid-2">
        <label className="field">
          <span>Dentro de</span>
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">— Ninguna: familia principal —</option>
            {parents.map((x) => (
              <option key={x.id} value={x.id}>
                {x.path}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Unidad habitual</span>
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            {props.units.map((u) => (
              <option key={u.code} value={u.code}>
                {u.name} ({u.code})
              </option>
            ))}
          </select>
          <small className="muted">La que se propone al dar de alta un contenido de esta familia.</small>
        </label>
      </div>
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={busy}>
          Guardar
        </button>
      </div>
    </form>
  );
}
