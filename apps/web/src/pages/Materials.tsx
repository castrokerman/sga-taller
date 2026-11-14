import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, errorMessage, formatQty, TRACKING_NAMES, type Family, type Material, type MaterialInput, type Unit, type User } from '../api';
import { Highlight, optionsFrom, useListControls, type ListConfig } from '../components/ListControls';
import { navigate } from '../router';
import { BulkEditor, type BulkChanges } from '../components/BulkEditor';

const FAMILY_KEY = 'sga.familia-elegida';

/** Catálogo de materiales: familias a la izquierda, lista con orden y filtros. */
export function MaterialsPage({ user }: { user: User }) {
  const [materials, setMaterials] = useState<Material[] | null>(null);
  const [families, setFamilies] = useState<Family[]>([]);
  const [familyId, setFamilyId] = useState<string>(() => {
    try {
      return window.localStorage.getItem(FAMILY_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [obsolete, setObsolete] = useState(false);
  const [creating, setCreating] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const can = (p: string) => user.permissions.includes(p);

  const load = async (withObsolete = obsolete) => {
    try {
      const [m, f] = await Promise.all([api.materials(withObsolete), api.families()]);
      setMaterials(m.materials);
      setFamilies(f.families);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseFamily = (id: string) => {
    setFamilyId(id);
    try {
      window.localStorage.setItem(FAMILY_KEY, id);
    } catch {
      /* sin almacenamiento local */
    }
  };

  // Materiales de cada familia, contando también los de sus subfamilias.
  const counts = useMemo(() => {
    const byFamily = new Map<string, number>();
    for (const m of materials ?? []) {
      const fam = families.find((f) => f.id === m.familyId);
      for (const id of fam?.ancestorIds ?? [m.familyId]) byFamily.set(id, (byFamily.get(id) ?? 0) + 1);
    }
    return byFamily;
  }, [materials, families]);

  const inFamily = useMemo(() => {
    const all = materials ?? [];
    if (!familyId) return all;
    return all.filter((m) => families.find((f) => f.id === m.familyId)?.ancestorIds.includes(familyId));
  }, [materials, families, familyId]);

  const list = useListControls(inFamily, materialListConfig(inFamily));
  const family = families.find((f) => f.id === familyId);

  return (
    <>
      <nav className="crumbs">
        <a href="#/inicio">Inicio</a>
        <span>
          <i>›</i>
          <strong>Materiales</strong>
        </span>
      </nav>
      <div className="page-head">
        <div>
          <h2>Materiales</h2>
          <p className="muted nomargin">Catálogo de todo lo que se guarda en el almacén</p>
        </div>
        <div className="push-right row-actions">
          <a className="btn" href="/api/export/materiales.xlsx" download>
            Exportar a Excel
          </a>
          {can('material.manage') && (
            <a className="btn" href="#/familias">
              Gestionar familias
            </a>
          )}
          {can('material.manage') && (materials?.length ?? 0) > 1 && (
            <button className="btn" onClick={() => { setNotice(null); setCreating(false); setBulk(true); }}>
              Editar en tabla
            </button>
          )}
          {can('material.manage') && (
            <button className="btn btn-primary" onClick={() => { setBulk(false); setCreating(true); }}>
              + Nuevo material
            </button>
          )}
        </div>
      </div>
      {notice && <p className="alert alert-ok">{notice}</p>}
      {error && <p className="alert alert-error">{error}</p>}
      {bulk && (
        <BulkMaterials
          rows={list.visible}
          families={families}
          onClose={async (m) => {
            setBulk(false);
            if (m) {
              await load();
              setNotice(m);
            }
          }}
        />
      )}
      {creating && (
        <MaterialForm
          title="Nuevo material"
          initial={family ? { familyId: family.id, unitCode: family.defaultUnitCode ?? undefined } : undefined}
          onCancel={() => setCreating(false)}
          onDone={(m) => navigate(`material/${m.id}`)}
        />
      )}

      <div className="mat-layout">
        <div className="card fam">
          <b className="fam-title">Familias</b>
          <select className="fam-select" value={familyId} onChange={(e) => chooseFamily(e.target.value)} aria-label="Familia">
            <option value="">Todas ({materials?.length ?? 0})</option>
            {families.filter((f) => f.active || counts.get(f.id)).map((f) => (
              <option key={f.id} value={f.id}>
                {'  '.repeat(f.ancestorIds.length - 1)}
                {f.name} ({counts.get(f.id) ?? 0})
              </option>
            ))}
          </select>
          <div className="fam-list">
            <button className={!familyId ? 'on' : undefined} onClick={() => chooseFamily('')}>
              Todas <span>{materials?.length ?? 0}</span>
            </button>
            {families.filter((f) => f.active || counts.get(f.id)).map((f) => (
              <button
                key={f.id}
                className={familyId === f.id ? 'on' : undefined}
                style={{ paddingLeft: `${0.7 + (f.ancestorIds.length - 1) * 0.9}rem` }}
                onClick={() => chooseFamily(f.id)}
              >
                {f.name} <span>{counts.get(f.id) ?? 0}</span>
              </button>
            ))}
          </div>
          <label className="check small">
            <input
              type="checkbox"
              checked={obsolete}
              onChange={(e) => {
                setObsolete(e.target.checked);
                void load(e.target.checked);
              }}
            />
            <span>Ver también los dados de baja</span>
          </label>
        </div>

        <div>
          {materials === null ? (
            <p className="muted">Cargando…</p>
          ) : materials.length === 0 ? (
            <p className="alert alert-info">
              Todavía no hay materiales. {can('material.manage') ? 'Crea el primero con «+ Nuevo material», o desde un contenedor con «+ Entrada».' : ''}
            </p>
          ) : (
            <>
              {list.bar}
              <div className="table-wrap card">
                <table className="mat-table">
                  <thead>
                    <tr>
                      <th>Material</th>
                      <th className="hide-m">Familia</th>
                      <th className="hide-m">Se cuenta</th>
                      <th className="num">En almacén</th>
                      <th className="hide-m">Dónde</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.visible.map((m) => (
                      <tr key={m.id} className="clickable" onClick={() => navigate(`material/${m.id}`)}>
                        <td>
                          <a href={`#/material/${m.id}`} onClick={(e) => e.stopPropagation()}>
                            <strong>
                              <Highlight text={m.description} query={list.query} />
                            </strong>
                          </a>
                          <div className="muted small">
                            <Highlight text={m.internalRef} query={list.query} />
                            {m.manufacturerRef && <> · <Highlight text={m.manufacturerRef} query={list.query} /></>}
                            {m.status === 'OBSOLETE' && <span className="badge badge-off"> De baja</span>}
                            {m.isLoanable && <span className="badge badge-ok"> Prestable</span>}
                          </div>
                        </td>
                        <td className="hide-m">{m.familyName}</td>
                        <td className="hide-m">{TRACKING_NAMES[m.quantityTracking]}</td>
                        <td className={`num nowrap ${m.lowStock ? 'low' : ''}`}>
                          <strong>{m.places === 0 ? <span className="muted">Sin stock</span> : formatQty(m.quantity, m.unitCode, m.quantityTracking)}</strong>
                          {m.lowStock && <div className="small">Stock bajo</div>}
                          {m.onLoan > 0 && <div className="small muted">{formatQty(m.onLoan, m.unitCode)} prestado</div>}
                        </td>
                        <td className="hide-m">{m.places === 0 ? '—' : m.places === 1 ? '1 sitio' : `${m.places} sitios`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {list.visible.length === 0 && <p className="muted">Ningún material cumple los filtros.</p>}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function materialListConfig(items: Material[]): ListConfig<Material> {
  return {
    storageKey: 'materiales',
    noun: 'materiales',
    placeholder: 'Buscar por nombre, referencia, fabricante…',
    text: (m) => [m.description, m.internalRef, m.manufacturer, m.manufacturerRef, m.materialSpec, m.qualityGrade, m.dimensions, m.familyName],
    sorts: [
      { key: 'nombre', label: 'Nombre', value: (m) => m.description },
      { key: 'referencia', label: 'Referencia', value: (m) => m.internalRef },
      { key: 'familia', label: 'Familia', value: (m) => m.familyName },
      { key: 'cantidad', label: 'Cantidad', value: (m) => (m.quantityTracking === 'NOT_TRACKED' ? null : m.quantity ?? 0), defaultDir: 'desc' },
      { key: 'alta', label: 'Fecha de alta', value: (m) => m.createdAt, defaultDir: 'desc' },
    ],
    filters: [
      {
        key: 'estado', label: 'Estado del stock',
        options: [
          { value: 'bajo', label: 'Stock bajo' },
          { value: 'sin', label: 'Sin stock' },
          { value: 'con', label: 'Con stock' },
          { value: 'recontar', label: 'Pendiente de recontar' },
        ],
        test: (m, v) => (v === 'bajo' ? m.lowStock : v === 'sin' ? m.places === 0 : v === 'con' ? m.places > 0 : m.needsRecount),
      },
      {
        key: 'cuenta', label: 'Cómo se cuenta',
        options: Object.entries(TRACKING_NAMES).map(([value, label]) => ({ value, label })),
        test: (m, v) => m.quantityTracking === v,
      },
      {
        key: 'prestable', label: 'Herramientas',
        options: [{ value: 'si', label: 'Solo prestables' }, { value: 'prestado', label: 'Con algo prestado' }],
        test: (m, v) => (v === 'si' ? m.isLoanable : m.onLoan > 0),
      },
      { key: 'fabricante', label: 'Fabricante', options: optionsFrom(items, (m) => m.manufacturer), test: (m, v) => m.manufacturer === v },
    ],
  };
}

/** Alta, edición o duplicado de un material. */
export function MaterialForm(props: {
  title: string;
  initial?: MaterialInput;
  materialId?: string;
  embedded?: boolean;
  onCancel: () => void;
  onDone: (m: Material) => void;
}) {
  const init = props.initial ?? {};
  const [families, setFamilies] = useState<Family[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [f, setF] = useState<MaterialInput>({
    description: '', familyId: '', unitCode: 'ud', quantityTracking: 'EXACT', lotTracked: false, isLoanable: false,
    ...init,
  });
  const [min, setMin] = useState(init.minStock != null ? String(init.minStock).replace('.', ',') : '');
  const [more, setMore] = useState(Boolean(init.manufacturer || init.manufacturerRef || init.materialSpec || init.qualityGrade || init.dimensions || init.notes));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.families(), api.units()])
      .then(([fa, u]) => {
        setFamilies(fa.families.filter((x) => x.active || x.id === init.familyId));
        setUnits(u.units);
      })
      .catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = <K extends keyof MaterialInput>(k: K, v: MaterialInput[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const minStock = min.trim() === '' ? null : Number(min.replace(',', '.'));
    if (minStock !== null && (!Number.isFinite(minStock) || minStock < 0)) {
      setError('El aviso de stock bajo tiene que ser un número');
      setBusy(false);
      return;
    }
    const keys = ['description', 'familyId', 'internalRef', 'manufacturer', 'manufacturerRef', 'materialSpec', 'qualityGrade',
      'dimensions', 'unitCode', 'quantityTracking', 'lotTracked', 'isLoanable', 'notes', 'status'] as const;
    const data: MaterialInput = Object.fromEntries(keys.filter((k) => f[k] !== undefined).map((k) => [k, f[k]]));
    data.description = f.description?.trim();
    data.minStock = f.quantityTracking === 'NOT_TRACKED' ? null : minStock;
    for (const k of ['manufacturer', 'manufacturerRef', 'materialSpec', 'qualityGrade', 'dimensions', 'notes'] as const) {
      if (data[k] === '' || data[k] === undefined) data[k] = null;
    }
    if (!props.materialId) {
      delete data.status;
      if (!data.internalRef) delete data.internalRef;
    }
    try {
      const r = props.materialId ? await api.updateMaterial(props.materialId, data) : await api.createMaterial(data);
      props.onDone(r.material);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <>
      {!props.embedded && <h3>{props.title}</h3>}
      <label className="field">
        <span>Descripción</span>
        <input value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} maxLength={300} required autoFocus placeholder="Tornillo DIN 912 M6x20 inox A2" />
      </label>
      <div className="grid-2">
        <label className="field">
          <span>Familia</span>
          <select
            value={f.familyId ?? ''}
            required
            onChange={(e) => {
              const fam = families.find((x) => x.id === e.target.value);
              setF((x) => ({ ...x, familyId: e.target.value, ...(fam?.defaultUnitCode && !props.materialId ? { unitCode: fam.defaultUnitCode } : {}) }));
            }}
          >
            <option value="">Elige una familia</option>
            {families.map((x) => (
              <option key={x.id} value={x.id}>
                {'  '.repeat(x.ancestorIds.length - 1)}
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Unidad</span>
          <select value={f.unitCode} onChange={(e) => set('unitCode', e.target.value)}>
            {units.map((u) => (
              <option key={u.code} value={u.code}>
                {u.name} ({u.code})
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="field">
        <legend>Cómo se cuenta</legend>
        <div className="seg">
          {(['EXACT', 'ESTIMATED', 'NOT_TRACKED'] as const).map((t) => (
            <label key={t} className={f.quantityTracking === t ? 'on' : undefined}>
              <input type="radio" name="cuenta" checked={f.quantityTracking === t} onChange={() => set('quantityTracking', t)} />
              <b>{TRACKING_NAMES[t]}</b>
              <small>
                {t === 'EXACT' ? 'Se cuenta una a una. No se puede retirar más de lo que hay.' : t === 'ESTIMATED' ? 'A ojo, por ejemplo tornillería a granel.' : 'Solo se anota que hay y quién se lleva.'}
              </small>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid-2">
        {f.quantityTracking !== 'NOT_TRACKED' && (
          <label className="field">
            <span>
              Avisar si baja de <span className="muted">(opcional)</span>
            </span>
            <input value={min} onChange={(e) => setMin(e.target.value.replace(/[^\d,.]/g, ''))} inputMode="decimal" placeholder={`En ${f.unitCode}`} />
          </label>
        )}
        <label className="field">
          <span>
            Referencia interna <span className="muted">(opcional)</span>
          </span>
          <input value={f.internalRef ?? ''} onChange={(e) => set('internalRef', e.target.value)} maxLength={40} placeholder={props.materialId ? '' : 'Se pone sola: MAT-000001…'} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={Boolean(f.isLoanable)} onChange={(e) => set('isLoanable', e.target.checked)} />
        <span>
          <strong>Herramienta que se presta</strong>
          <small className="muted"> — se presta y se devuelve, no se gasta</small>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={Boolean(f.lotTracked)} onChange={(e) => set('lotTracked', e.target.checked)} />
        <span>
          <strong>Exigir lote en cada entrada</strong>
          <small className="muted"> — para material con certificado o colada</small>
        </span>
      </label>
      {!more ? (
        <button type="button" className="linkbtn" onClick={() => setMore(true)}>
          + Fabricante, calidad, dimensiones y notas
        </button>
      ) : (
        <>
          <div className="grid-2">
            <label className="field">
              <span>Fabricante</span>
              <input value={f.manufacturer ?? ''} onChange={(e) => set('manufacturer', e.target.value)} maxLength={120} />
            </label>
            <label className="field">
              <span>Referencia del fabricante</span>
              <input value={f.manufacturerRef ?? ''} onChange={(e) => set('manufacturerRef', e.target.value)} maxLength={80} />
            </label>
            <label className="field">
              <span>Material</span>
              <input value={f.materialSpec ?? ''} onChange={(e) => set('materialSpec', e.target.value)} maxLength={80} placeholder="Acero, aluminio…" />
            </label>
            <label className="field">
              <span>Calidad</span>
              <input value={f.qualityGrade ?? ''} onChange={(e) => set('qualityGrade', e.target.value)} maxLength={80} placeholder="S355, 6082-T6, A2…" />
            </label>
          </div>
          <label className="field">
            <span>Dimensiones</span>
            <input value={f.dimensions ?? ''} onChange={(e) => set('dimensions', e.target.value)} maxLength={120} />
          </label>
          <label className="field">
            <span>Notas</span>
            <textarea value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} maxLength={1000} rows={2} />
          </label>
        </>
      )}
      {props.materialId && (
        <label className="check">
          <input type="checkbox" checked={f.status === 'OBSOLETE'} onChange={(e) => set('status', e.target.checked ? 'OBSOLETE' : 'ACTIVE')} />
          <span>
            <strong>Dado de baja</strong>
            <small className="muted"> — ya no se compra ni se da de alta; conserva su historial</small>
          </span>
        </label>
      )}
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Guardando…' : props.materialId ? 'Guardar' : 'Crear material'}
        </button>
      </div>
    </>
  );

  return props.embedded ? (
    <form onSubmit={save}>
      <p className="muted">Material nuevo en el catálogo. Después indicas la cantidad que entra.</p>
      {body}
    </form>
  ) : (
    <form className="card form" onSubmit={save}>
      {body}
    </form>
  );
}

/** Edición en tabla de los materiales que se ven en la lista. */
function BulkMaterials(props: { rows: Material[]; families: Family[]; onClose: (message?: string) => void }) {
  const famOptions = props.families
    .filter((f) => f.active)
    .map((f) => ({ value: f.id, label: `${'\u00a0\u00a0'.repeat(f.ancestorIds.length - 1)}${f.name}` }));

  const save = async (changes: BulkChanges) => {
    const items = changes.map(({ id, values }) => {
      const item: { id: string } & MaterialInput = { id };
      for (const [k, v] of Object.entries(values)) {
        if (k === 'minStock') {
          const n = Number(String(v).replace(',', '.'));
          if (String(v).trim() !== '' && !Number.isFinite(n)) throw new Error('El aviso de stock bajo tiene que ser un número');
          item.minStock = String(v).trim() === '' ? null : n;
        } else if (k === 'isLoanable') item.isLoanable = Boolean(v);
        else if (k === 'status') item.status = v as 'ACTIVE' | 'OBSOLETE';
        else if (k === 'familyId') item.familyId = String(v);
        else if (k === 'description') item.description = String(v);
        else (item as Record<string, unknown>)[k] = String(v).trim() === '' ? null : String(v);
      }
      return item;
    });
    await api.bulkMaterials(items);
    return `Guardados los cambios de ${items.length} material${items.length > 1 ? 'es' : ''}`;
  };

  return (
    <BulkEditor
      title={`Editar ${props.rows.length} materiales`}
      hint="Se editan los que se ven en la lista: usa la familia, la búsqueda y los filtros para elegir cuáles. Lo cambiado se marca en amarillo y se guarda todo junto."
      rows={props.rows}
      onSave={save}
      onClose={props.onClose}
      columns={[
        { key: 'ref', label: 'Referencia', type: 'static', get: (m) => m.internalRef },
        { key: 'description', label: 'Descripción', type: 'text', get: (m) => m.description, width: '260px' },
        { key: 'familyId', label: 'Familia', type: 'select', required: true, fillAll: true, get: (m) => m.familyId, options: famOptions, width: '170px' },
        { key: 'minStock', label: 'Avisar si baja de', type: 'number', decimals: true, fillAll: true,
          get: (m) => (m.minStock === null ? '' : String(m.minStock).replace('.', ',')), width: '90px' },
        { key: 'isLoanable', label: 'Prestable', type: 'check', fillAll: true, get: (m) => m.isLoanable },
        { key: 'manufacturer', label: 'Fabricante', type: 'text', fillAll: true, get: (m) => m.manufacturer ?? '', width: '140px' },
        { key: 'manufacturerRef', label: 'Ref. fabricante', type: 'text', get: (m) => m.manufacturerRef ?? '', width: '130px' },
        { key: 'materialSpec', label: 'Material', type: 'text', fillAll: true, get: (m) => m.materialSpec ?? '', width: '110px' },
        { key: 'qualityGrade', label: 'Calidad', type: 'text', fillAll: true, get: (m) => m.qualityGrade ?? '', width: '100px' },
        { key: 'dimensions', label: 'Dimensiones', type: 'text', get: (m) => m.dimensions ?? '', width: '120px' },
        { key: 'status', label: 'Estado', type: 'select', required: true, fillAll: true, get: (m) => m.status,
          options: [{ value: 'ACTIVE', label: 'Activo' }, { value: 'OBSOLETE', label: 'De baja' }], width: '110px' },
      ]}
    />
  );
}
