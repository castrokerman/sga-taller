import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage, formatDate, type PreReceipt, type ProjectOption, type User } from '../api';
import { navigate } from '../router';

const STATUS = {
  OPEN: { label: 'Esperando', cls: 'badge-warn' },
  RECEIVED: { label: 'Ha llegado', cls: 'badge-ok' },
  CANCELLED: { label: 'Cancelada', cls: 'badge-off' },
} as const;

/** Lo que alguien espera que llegue, para que el almacén lo reconozca al recibirlo. */
export function PreReceiptsPage({ user }: { user: User }) {
  const [scope, setScope] = useState<'mine' | 'open'>('mine');
  const [data, setData] = useState<{ items: PreReceipt[]; canSeeAll: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.preReceipts(scope).then(setData).catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    setData(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const cancel = async (p: PreReceipt) => {
    if (!window.confirm(`¿Cancelar ${p.code} (${p.description})?`)) return;
    try {
      await api.cancelPreReceipt(p.id);
      setNotice(`${p.code} cancelada.`);
      await load();
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
          <strong>Pre-recepciones</strong>
        </span>
      </nav>
      <div className="page-head">
        <div>
          <h2>Pre-recepciones</h2>
          <p className="muted nomargin">
            Avisa de lo que esperas que llegue. Cuando el almacén reciba un paquete, se lo propondrá, y te llegará el aviso para identificarlo.
          </p>
        </div>
        {!creating && (
          <button className="btn btn-primary push-right" onClick={() => { setNotice(null); setCreating(true); }}>
            + Avisar de un pedido
          </button>
        )}
      </div>
      {notice && <p className="alert alert-ok">{notice}</p>}
      {error && <p className="alert alert-error">{error}</p>}
      {creating && (
        <PreReceiptForm
          onCancel={() => setCreating(false)}
          onDone={async (code) => {
            setCreating(false);
            setScope('mine');
            setNotice(`${code} creada. El almacén la verá al recibir paquetes.`);
            await load();
          }}
        />
      )}
      {data?.canSeeAll && (
        <div className="filters-row">
          <div className="segbar" role="group" aria-label="Cuáles">
            <button className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>Las mías</button>
            <button className={scope === 'open' ? 'on' : ''} onClick={() => setScope('open')}>Todas las que se esperan</button>
          </div>
        </div>
      )}
      {data === null ? (
        <p className="muted">Cargando…</p>
      ) : data.items.length === 0 ? (
        <p className="muted">{scope === 'mine' ? 'No has avisado de ningún pedido.' : 'No se espera nada.'}</p>
      ) : (
        <div className="list">
          {data.items.map((p) => (
            <div key={p.id} className={`item ${p.late ? 'item-todo' : ''}`}>
              <span className="item-main">
                <strong>{p.description}</strong>
                <span>
                  <span className="mono">{p.code}</span>
                  {p.supplier && ` · ${p.supplier}`}
                  {p.orderRef && ` · pedido ${p.orderRef}`}
                  {p.projectLabel && ` · ${p.projectLabel}`}
                </span>
                <small className="muted">
                  {scope === 'open' && `De ${p.createdBy} · `}
                  {p.expectedDate ? `Se espera el ${formatDate(p.expectedDate)}` : 'Sin fecha prevista'}
                  {p.late && ' · atrasada'}
                  {p.note && ` · ${p.note}`}
                </small>
              </span>
              <span className="item-meta">
                <span className={`badge ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span>
                {p.inboundId && (
                  <button className="linkbtn" onClick={() => navigate(`recepcion/${p.inboundId}`)}>
                    Ver {p.inboundCode}
                  </button>
                )}
                {p.status === 'OPEN' && (p.createdById === user.id || user.permissions.includes('inbound.manage')) && (
                  <button className="linkbtn" onClick={() => cancel(p)}>
                    Cancelar
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function PreReceiptForm(props: { onCancel: () => void; onDone: (code: string) => void }) {
  const [description, setDescription] = useState('');
  const [supplier, setSupplier] = useState('');
  const [orderRef, setOrderRef] = useState('');
  const [expected, setExpected] = useState('');
  const [projectId, setProjectId] = useState('');
  const [note, setNote] = useState('');
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.projectOptions().then((r) => setProjects(r.projects)).catch(() => undefined);
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return setError('Indica qué esperas que llegue');
    setBusy(true);
    setError(null);
    try {
      const r = await api.createPreReceipt({
        description: description.trim(), supplier: supplier.trim() || undefined, orderRef: orderRef.trim() || undefined,
        note: note.trim() || undefined, projectId: projectId || null, expectedDate: expected || null,
      });
      props.onDone(r.code);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card form" onSubmit={submit}>
      <h3>Avisar de un pedido</h3>
      <label className="field">
        <span>Qué esperas que llegue</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} autoFocus placeholder="3 sensores inductivos M12 PNP" />
      </label>
      <div className="grid-2">
        <label className="field">
          <span>Proveedor <span className="muted">(opcional)</span></span>
          <input value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={150} placeholder="RS, Würth, Amazon…" />
        </label>
        <label className="field">
          <span>Nº de pedido <span className="muted">(opcional)</span></span>
          <input value={orderRef} onChange={(e) => setOrderRef(e.target.value)} maxLength={80} />
        </label>
        <label className="field">
          <span>Cuándo se espera <span className="muted">(opcional)</span></span>
          <input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
        </label>
        <label className="field">
          <span>Proyecto <span className="muted">(opcional)</span></span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Sin proyecto</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Nota para el almacén <span className="muted">(opcional)</span></span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Viene en una caja grande; avisadme al llegar" />
      </label>
      <small className="muted">Si lo pones en un proyecto, al llegar se avisará a sus responsables además de a ti.</small>
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Guardando…' : 'Avisar'}
        </button>
      </div>
    </form>
  );
}
