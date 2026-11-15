import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  api, errorMessage, formatDate, formatDateTime, formatQty, photoUrl,
  type Person, type Project, type ProjectDetail, type ProjectStatus, type User,
} from '../api';
import { navigate } from '../router';

const STATUS: Record<ProjectStatus, { label: string; cls: string }> = {
  ACTIVE: { label: 'Activo', cls: 'badge-ok' },
  ON_HOLD: { label: 'En pausa', cls: 'badge-warn' },
  CLOSED: { label: 'Cerrado', cls: 'badge-off' },
};
const ROLE = { RESPONSIBLE: 'Responsable', MEMBER: 'Miembro' } as const;

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const names = (p: Person[]) => p.map((x) => x.fullName).join(', ') || '—';

function Crumbs({ last }: { last?: string }) {
  return (
    <nav className="crumbs">
      <a href="#/inicio">Inicio</a>
      <span>
        <i>›</i>
        {last ? <a href="#/proyectos">Proyectos</a> : <strong>Proyectos</strong>}
      </span>
      {last && (
        <span>
          <i>›</i>
          <strong>{last}</strong>
        </span>
      )}
    </nav>
  );
}

// ---- Lista ----------------------------------------------------------------------

export function ProjectsPage({ user }: { user: User }) {
  const [data, setData] = useState<{ projects: Project[]; canManage: boolean } | null>(null);
  const [closed, setClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.projects(closed).then(setData).catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closed]);

  const manage = data?.canManage ?? user.permissions.includes('project.manage');
  return (
    <>
      <Crumbs />
      <div className="page-head">
        <div>
          <h2>{manage ? 'Proyectos' : 'Tus proyectos'}</h2>
          <p className="muted nomargin">
            Sus responsables ven todo lo del proyecto y son los únicos que pueden sacar lo que hay en sus contenedores.
          </p>
        </div>
        {manage && !creating && (
          <button className="btn btn-primary push-right" onClick={() => setCreating(true)}>
            + Nuevo proyecto
          </button>
        )}
      </div>
      {error && <p className="alert alert-error">{error}</p>}
      {creating && (
        <ProjectForm
          onCancel={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            navigate(`proyecto/${id}`);
          }}
        />
      )}
      <label className="check">
        <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
        <span>Ver también los cerrados</span>
      </label>
      {data === null ? (
        <p className="muted">Cargando…</p>
      ) : data.projects.length === 0 ? (
        <p className="muted">{manage ? 'Todavía no hay proyectos. Crea el primero con «+ Nuevo proyecto».' : 'No estás en ningún proyecto.'}</p>
      ) : (
        <div className="list">
          {data.projects.map((p) => (
            <button key={p.id} className={`item ${p.status === 'CLOSED' ? 'item-off' : ''}`} onClick={() => navigate(`proyecto/${p.id}`)}>
              <span className="item-main">
                <strong>
                  <span className="mono">{p.code}</span> · {p.name}
                </strong>
                <span>Responsables: {names(p.responsibles)}</span>
                {p.members.length > 0 && <small className="muted">Miembros: {names(p.members)}</small>}
              </span>
              <span className="item-meta">
                <span className={`badge ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span>
                {p.myRole && <span className="tag tag-type">{ROLE[p.myRole]}</span>}
                <small className="muted">
                  {p.containerCount} contenedor{p.containerCount === 1 ? '' : 'es'}
                  {p.pendingInbound > 0 && ` · ${p.pendingInbound} por identificar`}
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ---- Alta y edición ---------------------------------------------------------------

/** Elegir varias personas, con búsqueda. El orden de elección se respeta (el primero es el principal). */
function PeoplePicker(props: { people: Person[] | null; value: string[]; onChange: (ids: string[]) => void; exclude?: string[]; ordered?: boolean }) {
  const [q, setQ] = useState('');
  const all = (props.people ?? []).filter((p) => !props.exclude?.includes(p.id));
  const chosen = props.value.map((id) => (props.people ?? []).find((p) => p.id === id)).filter(Boolean) as Person[];
  const shown = all.filter((p) => !props.value.includes(p.id) && (!q || normalize(p.fullName).includes(normalize(q))));
  return (
    <div className="people-picker">
      <div className="pchips">
        {chosen.map((p, i) => (
          <span key={p.id} className="pchip on">
            {props.ordered && i === 0 && props.value.length > 1 ? `${p.fullName} (principal)` : p.fullName}
            <button type="button" className="pchip-x" aria-label={`Quitar a ${p.fullName}`} onClick={() => props.onChange(props.value.filter((x) => x !== p.id))}>
              ×
            </button>
          </span>
        ))}
        {chosen.length === 0 && <span className="muted small">Nadie elegido todavía.</span>}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Escribe para buscar y añadir…" />
      {q && (
        <div className="pick pick-short">
          {shown.slice(0, 8).map((p) => (
            <button
              type="button"
              key={p.id}
              className="pick-btn"
              onClick={() => {
                props.onChange([...props.value, p.id]);
                setQ('');
              }}
            >
              <span>
                <b>{p.fullName}</b>
              </span>
            </button>
          ))}
          {shown.length === 0 && <p className="muted">Nadie más coincide.</p>}
        </div>
      )}
    </div>
  );
}

function ProjectForm(props: { project?: Project; onCancel: () => void; onSaved: (id: string) => void }) {
  const p = props.project;
  const [code, setCode] = useState(p?.code ?? '');
  const [name, setName] = useState(p?.name ?? '');
  const [description, setDescription] = useState(p?.description ?? '');
  const [status, setStatus] = useState<ProjectStatus>(p?.status ?? 'ACTIVE');
  const [responsibles, setResponsibles] = useState<string[]>(p?.responsibles.map((x) => x.id) ?? []);
  const [members, setMembers] = useState<string[]>(p?.members.map((x) => x.id) ?? []);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.basicUsers().then((r) => setPeople(r.users)).catch((e) => setError(errorMessage(e)));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!code.trim() || !name.trim()) return setError('Indica el código y el nombre');
    if (!responsibles.length) return setError('Indica al menos un responsable');
    setBusy(true);
    try {
      const data = {
        code: code.trim(), name: name.trim(), description: description.trim(), status,
        responsibleIds: responsibles, memberIds: members.filter((m) => !responsibles.includes(m)),
      };
      if (p) {
        await api.updateProject(p.id, data);
        props.onSaved(p.id);
      } else {
        props.onSaved((await api.createProject(data)).id);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h3>{p ? `Editar ${p.code}` : 'Nuevo proyecto'}</h3>
      <div className="grid-2">
        <label className="field">
          <span>Código</span>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={30} placeholder="PRJ-2026-014" autoFocus={!p} />
        </label>
        <label className="field">
          <span>Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={150} placeholder="Banco de ensayos de válvulas" />
        </label>
      </div>
      <label className="field">
        <span>
          Descripción <span className="muted">(opcional)</span>
        </span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
      </label>
      <div className="field">
        <span className="field-l">Responsables</span>
        <small className="muted">Ven todo lo del proyecto y son los únicos que pueden sacar lo reservado. El primero es el principal.</small>
        <PeoplePicker people={people} value={responsibles} onChange={setResponsibles} ordered />
      </div>
      <div className="field">
        <span className="field-l">
          Miembros <span className="muted">(opcional)</span>
        </span>
        <small className="muted">Quedan asociados al proyecto, pero no ven todo ni pueden sacar lo reservado.</small>
        <PeoplePicker people={people} value={members} onChange={setMembers} exclude={responsibles} />
      </div>
      {p && (
        <label className="field narrow">
          <span>Estado</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
            <option value="ACTIVE">Activo</option>
            <option value="ON_HOLD">En pausa</option>
            <option value="CLOSED">Cerrado</option>
          </select>
        </label>
      )}
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Guardando…' : p ? 'Guardar' : 'Crear proyecto'}
        </button>
      </div>
    </form>
  );
}

// ---- Ficha --------------------------------------------------------------------------

export function ProjectPage({ projectId }: { user: User; projectId: string }) {
  const [d, setD] = useState<ProjectDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.project(projectId).then(setD).catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    setD(null);
    setEditing(false);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const stockByPlace = useMemo(() => {
    const m = new Map<string, NonNullable<ProjectDetail['stock']>>();
    for (const s of d?.stock ?? []) m.set(s.placeCode, [...(m.get(s.placeCode) ?? []), s]);
    return m;
  }, [d]);

  if (error && !d) return (<><Crumbs last="…" /><p className="alert alert-error">{error}</p></>);
  if (!d) return (<><Crumbs last="…" /><p className="muted">Cargando…</p></>);
  const p = d.project;

  return (
    <>
      <Crumbs last={p.code} />
      <div className="page-head">
        <div>
          <h2>
            <span className="mono">{p.code}</span> · {p.name} <span className={`badge ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span>
          </h2>
          {p.description && <p className="muted nomargin">{p.description}</p>}
        </div>
        {d.canEdit && !editing && (
          <button className="btn push-right" onClick={() => setEditing(true)}>
            Editar
          </button>
        )}
      </div>
      {editing && (
        <ProjectForm
          project={p}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
      <div className="card">
        <dl className="facts">
          <dt>Responsables</dt>
          <dd>{names(p.responsibles)}</dd>
          <dt>Miembros</dt>
          <dd>{names(p.members)}</dd>
          {p.myRole && (<><dt>Tú</dt><dd>{ROLE[p.myRole]}</dd></>)}
        </dl>
      </div>

      {!d.full ? (
        <p className="alert alert-warn">Eres miembro de este proyecto. Todo lo del proyecto lo ven sus responsables.</p>
      ) : (
        <>
          <section className="card">
            <h3>Contenedores del proyecto</h3>
            <p className="muted small nomargin">
              Lo que hay dentro está reservado: solo los responsables del proyecto y los responsables de almacén pueden sacarlo, trasladarlo o
              prestarlo. Para añadir uno, ve al contenedor y elige el proyecto.
            </p>
            {d.containers!.length === 0 ? (
              <p className="muted">Ninguno todavía.</p>
            ) : (
              <div className="list">
                {d.containers!.map((c) => (
                  <button key={c.id} className="item" onClick={() => navigate(`contenedor/${c.id}`)}>
                    <span className="item-main">
                      <strong className="mono">{c.code}</strong>
                      <span>{c.description ?? c.typeName}</span>
                    </span>
                    <span className="item-meta">
                      <span>📍 {c.locationCode ?? '—'}</span>
                      <small className="muted">{c.lines} línea{c.lines === 1 ? '' : 's'}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <h3>Lo que tiene el proyecto</h3>
            {d.stock!.length === 0 ? (
              <p className="muted">Nada guardado en sus contenedores.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Contenido</th>
                      <th className="num">Cantidad</th>
                      <th>Dónde</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...stockByPlace.entries()].flatMap(([, lines]) =>
                      lines.map((s) => (
                        <tr key={s.id}>
                          <td>
                            <a href={`#/contenido/${s.materialId}`}>{s.description}</a> <span className="muted small">{s.internalRef}</span>
                            {s.lotCode && <span className="muted small"> · lote {s.lotCode}</span>}
                          </td>
                          <td className="num">{s.quantity === null ? 'Sin contar' : formatQty(s.quantity, s.unitCode)}</td>
                          <td className="mono">
                            {s.placeCode}
                            {s.locationCode && s.locationCode !== s.placeCode ? ` · ${s.locationCode}` : ''}
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <h3>Recepciones</h3>
            {d.inbound!.length === 0 ? (
              <p className="muted">Ninguna.</p>
            ) : (
              <div className="list">
                {d.inbound!.map((i) => (
                  <button key={i.id} className={`item ${i.status === 'PENDING' ? 'item-todo' : ''}`} onClick={() => navigate(`recepcion/${i.id}`)}>
                    {i.photoId ? <img className="item-photo" src={photoUrl(i.photoId)} alt="" loading="lazy" /> : <span className="item-photo" />}
                    <span className="item-main">
                      <strong>{i.materialDescription ?? i.description ?? 'Sin descripción'}</strong>
                      <span className="mono">{i.code}</span>
                    </span>
                    <span className="item-meta">
                      <span className={`badge ${i.status === 'PENDING' ? 'badge-warn' : 'badge-ok'}`}>{i.status === 'PENDING' ? 'Por identificar' : 'Identificada'}</span>
                      <small className="muted">{formatDate(i.receivedAt)}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <h3>Préstamos de lo del proyecto</h3>
            {d.loans!.length === 0 ? (
              <p className="muted">Nada prestado.</p>
            ) : (
              <ul className="plain">
                {d.loans!.map((l) => (
                  <li key={l.id} className={l.overdue ? 'over' : undefined}>
                    {l.description} · {formatQty(l.quantity, l.unitCode)} · <strong>{l.borrowerName}</strong> · devolver el {formatDate(l.dueAt)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h3>Últimos movimientos</h3>
            {d.movements!.length === 0 ? (
              <p className="muted">Ninguno.</p>
            ) : (
              <ul className="plain">
                {d.movements!.slice(0, 30).map((m) => (
                  <li key={`${m.movementId}-${m.lineNo}`}>
                    <span className="muted small">{formatDateTime(m.performedAt)}</span> · {m.performedBy} · {m.description}{' '}
                    {m.quantityDelta !== null && <strong>{m.quantityDelta > 0 ? '+' : ''}{formatQty(m.quantityDelta, m.unitCode)}</strong>} · {m.placeCode}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
