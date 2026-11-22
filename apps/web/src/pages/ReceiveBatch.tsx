import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage, newOperationKey, type ContentType, type Family, type Material, type OpResult, type User } from '../api';
import { ContentsPhotoPrompt } from '../components/ContentsPhoto';
import { PlaceSelect, type PickedPlace } from '../components/PlaceSelect';

/** Una fila: una cosa que entra. */
interface Row {
  id: number;
  type: string;
  text: string;
  materialId: string | null;
  familyId: string;
  quantity: string;
  place: PickedPlace | null;
  projectId: string;
  key: string;
  state: 'edit' | 'busy' | 'done' | 'error';
  message?: string;
  containers?: Array<{ id: string; code: string }>;
}

let nextId = 1;

/**
 * Varias cosas en una misma entrada: una fila por cosa. Se rellenan, se
 * revisan y se registran todas de una vez. Cada fila nueva copia el sitio y el
 * proyecto de la anterior para no repetirlos.
 */
export function ReceiveBatch(props: { user: User; onBack: () => void }) {
  const { user } = props;
  const [types, setTypes] = useState<ContentType[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [families, setFamilies] = useState<Family[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = user.permissions.includes('material.manage');

  useEffect(() => {
    Promise.all([api.contentTypes(), api.materials(), api.families(), api.projects()])
      .then(([t, m, f, p]) => {
        const active = t.types.filter((x) => x.active);
        setTypes(active);
        setMaterials(m.materials);
        setFamilies(f.families.filter((x) => x.active));
        setProjects(p.projects.filter((x) => x.status === 'ACTIVE'));
        setRows([blank(active[0]?.code ?? 'MATERIAL', null, '')]);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const blank = (type: string, place: PickedPlace | null, projectId: string): Row => ({
    id: nextId++, type, text: '', materialId: null, familyId: '', quantity: '1', place, projectId, key: newOperationKey(), state: 'edit',
  });

  const set = (id: number, patch: Partial<Row>) => setRows((all) => all.map((r) => (r.id === id ? { ...r, ...patch, state: r.state === 'error' ? 'edit' : r.state } : r)));

  const add = () =>
    setRows((all) => {
      const last = all[all.length - 1];
      return [...all, blank(last?.type ?? types[0]?.code ?? 'MATERIAL', last?.place ?? null, last?.projectId ?? '')];
    });

  const unitTracked = (code: string) => Boolean(types.find((t) => t.code === code)?.unitTracked);
  const label = (m: Material) => `${m.internalRef} · ${m.description}`;

  /** Lo que falta en una fila para poder registrarla, o null si está lista. */
  const missing = (r: Row): string | null => {
    if (!r.text.trim()) return 'el contenido';
    if (!r.materialId && !canCreate) return 'elegir uno del catálogo';
    if (!r.materialId && !r.familyId) return 'la familia del contenido nuevo';
    const q = Number(r.quantity.replace(',', '.'));
    if (!(q > 0)) return 'la cantidad';
    if (!r.place) return 'dónde se guarda';
    return null;
  };

  const pending = rows.filter((r) => r.state !== 'done');
  const ready = pending.length > 0 && pending.every((r) => !missing(r));

  const registerAll = async () => {
    setBusy(true);
    setError(null);
    for (const r of rows) {
      if (r.state === 'done') continue;
      set(r.id, { state: 'busy' });
      try {
        let materialId = r.materialId;
        if (!materialId) {
          const fam = families.find((f) => f.id === r.familyId);
          const created = await api.createMaterial({
            description: r.text.trim(), familyId: r.familyId, contentTypeCode: r.type,
            unitCode: unitTracked(r.type) ? 'ud' : fam?.defaultUnitCode ?? 'ud',
            quantityTracking: 'EXACT',
            isLoanable: types.find((t) => t.code === r.type)?.defaultLoanable ?? false,
          });
          materialId = created.material.id;
          setMaterials((all) => [...all, created.material]);
          set(r.id, { materialId });
        }
        const res: OpResult = await api.receive(
          { ...r.place!.ref, materialId, quantity: Number(r.quantity.replace(',', '.')), projectId: r.projectId || undefined },
          r.key,
        );
        setRows((all) => all.map((x) => (x.id === r.id ? { ...x, materialId, state: 'done', message: res.message, containers: res.containers } : x)));
      } catch (e) {
        setRows((all) => all.map((x) => (x.id === r.id ? { ...x, state: 'error', message: errorMessage(e), key: newOperationKey() } : x)));
      }
    }
    setBusy(false);
  };

  const done = rows.filter((r) => r.state === 'done');
  const touched = useMemo(() => {
    const m = new Map<string, { id: string; code: string }>();
    for (const r of done) for (const c of r.containers ?? []) m.set(c.id, c);
    return [...m.values()];
  }, [done]);

  return (
    <div className="card form op-form">
      <h3>Varias cosas a la vez</h3>
      <p className="muted nomargin">
        Una fila por cosa. Escribe para elegir uno ya registrado; si no está, se da de alta (elige su familia). Cada fila nueva copia el sitio
        y el proyecto de la anterior.
      </p>
      {error && <p className="alert alert-error">{error}</p>}
      <div className="batch">
        {rows.map((r, i) => {
          const list = materials.filter((m) => m.contentTypeCode === r.type && m.status === 'ACTIVE');
          const fams = families.filter((f) => f.contentTypeCode === r.type);
          const lock = r.state === 'done' || r.state === 'busy';
          const why = r.state === 'edit' ? missing(r) : null;
          return (
            <div key={r.id} className={`batch-row ${r.state}`}>
              <span className="batch-n">{i + 1}</span>
              <label className="field">
                <span>Tipo</span>
                <select value={r.type} disabled={lock} onChange={(e) => set(r.id, { type: e.target.value, text: '', materialId: null, familyId: '' })}>
                  {types.map((t) => (
                    <option key={t.code} value={t.code}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field batch-what">
                <span>Contenido</span>
                <input
                  list={`mats-${r.id}`}
                  value={r.text}
                  disabled={lock}
                  placeholder="Escribe la referencia o el nombre"
                  onChange={(e) => {
                    const text = e.target.value;
                    const hit = list.find((m) => label(m) === text);
                    set(r.id, { text, materialId: hit?.id ?? null });
                  }}
                />
                <datalist id={`mats-${r.id}`}>
                  {list.map((m) => (
                    <option key={m.id} value={label(m)} />
                  ))}
                </datalist>
                {r.text.trim() && !r.materialId && r.state === 'edit' && (
                  canCreate ? (
                    <select value={r.familyId} onChange={(e) => set(r.id, { familyId: e.target.value })} aria-label="Familia del contenido nuevo">
                      <option value="">Nuevo: elige su familia</option>
                      {(fams.length ? fams : families).map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.path}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <small className="muted">No está en el catálogo</small>
                  )
                )}
                {r.materialId && r.state === 'edit' && <small className="ok-text">Ya registrado</small>}
              </label>
              <label className="field batch-qty">
                <span>{unitTracked(r.type) ? 'Unidades' : 'Cantidad'}</span>
                <input value={r.quantity} inputMode="decimal" disabled={lock} onChange={(e) => set(r.id, { quantity: e.target.value })} />
              </label>
              <div className="field batch-where">
                <span className="field-l">Dónde</span>
                {lock ? <strong className="mono">{r.place?.code}</strong> : <PlaceSelect value={r.place} onChange={(p) => set(r.id, { place: p })} />}
              </div>
              <label className="field batch-proj">
                <span>Proyecto</span>
                <select value={r.projectId} disabled={lock} onChange={(e) => set(r.id, { projectId: e.target.value })}>
                  <option value="">Uso general</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code}
                    </option>
                  ))}
                </select>
              </label>
              <span className="batch-x">
                {r.state === 'edit' || r.state === 'error' ? (
                  <button type="button" className="linkbtn" disabled={busy || rows.length === 1} onClick={() => setRows(rows.filter((x) => x.id !== r.id))} aria-label="Quitar fila">
                    ✕
                  </button>
                ) : r.state === 'busy' ? '…' : '✓'}
              </span>
              {(r.message || why) && (
                <p className={`batch-msg ${r.state === 'error' ? 'err' : r.state === 'done' ? 'okm' : 'muted'}`}>
                  {r.message ?? `Falta ${why}`}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" className="btn" onClick={add} disabled={busy}>
        + Otra fila
      </button>
      {touched.length > 0 && <ContentsPhotoPrompt containers={touched} user={user} />}
      <div className="actions">
        <button className="btn" onClick={props.onBack} disabled={busy}>
          {done.length ? 'Cerrar' : 'Cancelar'}
        </button>
        <button className="btn btn-primary btn-big-inline" onClick={() => void registerAll()} disabled={busy || !ready}>
          {busy ? 'Registrando…' : `Registrar ${pending.length} ${pending.length === 1 ? 'fila' : 'filas'}`}
        </button>
      </div>
    </div>
  );
}
