import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage, type Family, type Unit, type User } from '../api';

/** Familias de material: las crean y cambian los responsables, con subfamilias. */
export function FamiliesPage({ user }: { user: User }) {
  const [families, setFamilies] = useState<Family[] | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [editing, setEditing] = useState<{ mode: 'new' | 'sub' | 'edit'; family?: Family } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manage = user.permissions.includes('material.manage');

  const load = async () => {
    try {
      const [f, u] = await Promise.all([api.families(), api.units()]);
      setFamilies(f.families);
      setUnits(u.units);
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
          <a href="#/materiales">Materiales</a>
        </span>
        <span>
          <i>›</i>
          <strong>Familias</strong>
        </span>
      </nav>
      <div className="page-head">
        <div>
          <h2>Familias de material</h2>
          <p className="muted nomargin">Las creáis y cambiáis vosotros cuando queráis. Pueden tener subfamilias.</p>
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
            <span>Materiales</span>
            <span />
          </div>
          {families.map((f) => (
            <div key={f.id} className={`famrow ${f.active ? '' : 'off'}`}>
              <span style={{ paddingLeft: `${(f.ancestorIds.length - 1) * 1.4}rem` }}>
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
      )}
      <p className="alert alert-info" style={{ marginTop: '1rem' }}>
        Una familia con materiales no se borra: se desactiva y deja de ofrecerse al dar de alta. Cambiar el nombre o moverla
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
  onCancel: () => void;
  onDone: (text: string) => void;
}) {
  const f = props.mode === 'edit' ? props.family : undefined;
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
        await api.updateFamily(f.id, { name: name.trim(), parentId: parentId || null, defaultUnitCode: unit || null });
        props.onDone('Familia guardada');
      } else {
        await api.createFamily({ name: name.trim(), parentId: parentId || undefined, defaultUnitCode: unit || undefined });
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
          <small className="muted">La que se propone al dar de alta un material de esta familia.</small>
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
