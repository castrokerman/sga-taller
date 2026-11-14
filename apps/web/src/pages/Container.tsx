import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage, formatDateTime, newOperationKey, type ContainerDetail, type ScanHit, type User } from '../api';
import { Breadcrumbs, ContainerCard, containerListConfig, LabelPanel } from '../components/Common';
import { useListControls } from '../components/ListControls';
import { Scanner } from '../components/Scanner';
import { StockSection } from '../components/Stock';
import { ItemExtras } from '../components/ItemExtras';
import { BulkContainers, ContainerForm } from './Warehouse';

type Panel = 'none' | 'move' | 'inside' | 'labels' | 'edit' | 'duplicate' | 'bulk';

const place = (location: string | null, container: string | null) => location ?? container ?? '—';

export function ContainerPage({ user, containerId }: { user: User; containerId: string }) {
  const [detail, setDetail] = useState<ContainerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('none');

  const can = (p: string) => user.permissions.includes(p);
  const inside = detail?.children ?? [];
  const insideList = useListControls(inside, containerListConfig(inside, 'contenedores-dentro'));

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await api.container(containerId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [containerId]);

  useEffect(() => {
    setDetail(null);
    setPanel('none');
    setNotice(null);
    void load();
  }, [load]);

  // Primero se recargan los datos y después se muestra el aviso, para que
  // lo que se ve en pantalla ya corresponda a lo que dice el mensaje.
  const done = async (text: string) => {
    setPanel('none');
    await load();
    setNotice(text);
  };

  const open = (next: Panel) => {
    setNotice(null);
    setError(null);
    setPanel(next);
  };

  const retire = async () => {
    if (!detail) return;
    const reason = window.prompt(`Motivo de la retirada de ${detail.container.code}:`, 'Contenedor desechado');
    if (reason === null) return;
    try {
      await api.retireContainer(containerId, reason || 'Retirada del contenedor', newOperationKey());
      await done('Contenedor retirado. Conserva su historial y su QR.');
    } catch (e) {
      setNotice(null);
      setError(errorMessage(e));
    }
  };

  if (!detail) return error ? <p className="alert alert-error">{error}</p> : <p className="muted">Cargando…</p>;

  const c = detail.container;
  const active = c.status === 'ACTIVE';
  const where = detail.locationPath.at(-1);

  return (
    <>
      <Breadcrumbs locations={detail.locationPath} containers={detail.containerPath} current={c.id} />

      <div className="page-head">
        <div>
          <h2>{c.code}</h2>
          <p className="muted nomargin">
            {c.typeName} · {c.reusePolicy === 'REUSABLE' ? 'Reutilizable' : 'Desechable'}
            {c.responsibleName && ` · Responsable: ${c.responsibleName}`}
          </p>
          {c.description && <p className="nomargin">{c.description}</p>}
        </div>
        <span className={`badge push-right ${active ? 'badge-ok' : 'badge-off'}`}>{active ? 'Activo' : 'Retirado'}</span>
      </div>

      {active && where && (
        <p className="where">
          Está en <strong>{where.code}</strong>
          {detail.containerPath.length > 1 && (
            <>
              , dentro de <strong>{detail.containerPath.at(-2)!.code}</strong>
            </>
          )}
        </p>
      )}
      {notice && <p className="alert alert-ok">{notice}</p>}
      {error && <p className="alert alert-error">{error}</p>}

      <div className="toolbar">
        {active && can('container.move') && (
          <button className="btn btn-primary" onClick={() => open('move')}>
            Mover
          </button>
        )}
        {active && can('container.manage') && (
          <button className="btn" onClick={() => open('inside')}>
            Nuevo contenedor dentro
          </button>
        )}
        {can('label.print') && (
          <button className="btn" onClick={() => open('labels')}>
            Etiqueta QR
          </button>
        )}
        {active && can('container.manage') && (
          <button className="btn" onClick={() => open('edit')}>
            Editar
          </button>
        )}
        {active && can('container.manage') && (
          <button className="btn" onClick={() => open('duplicate')}>
            Duplicar
          </button>
        )}
        {active && can('container.manage') && (
          <button className="btn btn-danger" onClick={retire}>
            Retirar
          </button>
        )}
      </div>

      {panel === 'move' && <MovePanel detail={detail} onCancel={() => setPanel('none')} onDone={done} />}
      {panel === 'inside' && (
        <ContainerForm
          where={{ parentContainerId: c.id }}
          onCancel={() => setPanel('none')}
          onDone={(codes) => done(`Creado${codes.length > 1 ? 's' : ''} dentro: ${codes.join(', ')}`)}
        />
      )}
      {panel === 'duplicate' && (
        <DuplicateContainerForm detail={detail} onCancel={() => setPanel('none')} onDone={(text) => done(text)} />
      )}
      {panel === 'edit' && <EditContainerForm detail={detail} onCancel={() => setPanel('none')} onDone={() => done('Cambios guardados')} />}
      {panel === 'labels' && (
        <LabelPanel
          onClose={() => setPanel('none')}
          groups={[
            { label: 'Este contenedor', items: [{ kind: 'container', id: c.id }] },
            { label: 'Contenedores de dentro', items: detail.children.map((k) => ({ kind: 'container' as const, id: k.id })) },
          ]}
        />
      )}

      <section>
        <div className="section-head">
          <h3>Contenedores dentro</h3>
          {active && can('container.manage') && detail.children.length > 1 && (
            <button className="btn btn-small push-right" onClick={() => open('bulk')}>
              Editar en tabla
            </button>
          )}
        </div>
        {panel === 'bulk' && <BulkContainers rows={insideList.visible} onClose={(m) => (m ? done(m) : setPanel('none'))} />}
        {detail.children.length > 0 ? (
          <>
            {detail.children.length > 1 && insideList.bar}
            <div className="items">
              {insideList.visible.map((k) => (
                <ContainerCard key={k.id} c={k} q={insideList.query} />
              ))}
            </div>
            {insideList.visible.length === 0 && <p className="muted">Ningún contenedor cumple los filtros.</p>}
          </>
        ) : (
          <p className="muted">No lleva otros contenedores dentro.</p>
        )}
      </section>

      <StockSection user={user} place={{ containerId: c.id }} placeCode={c.code} active={active} />

      <ItemExtras user={user} entityType="container" entityId={c.id} />

      <section>
        <h3>Historial del contenedor</h3>
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>De</th>
                <th>A</th>
                <th>Quién</th>
                <th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {detail.movements.map((m) => (
                <tr key={m.movementNumber}>
                  <td className="nowrap">{formatDateTime(m.performedAt)}</td>
                  <td>{place(m.fromLocation, m.fromContainer)}</td>
                  <td>{place(m.toLocation, m.toContainer)}</td>
                  <td>{m.performedBy}</td>
                  <td>{m.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/** Mover: se escanea (o se teclea) el destino y se confirma. */
function MovePanel(props: { detail: ContainerDetail; onCancel: () => void; onDone: (text: string) => void }) {
  const c = props.detail.container;
  const [dest, setDest] = useState<ScanHit | null>(null);
  const [key, setKey] = useState(newOperationKey);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onCode = async (code: string) => {
    if (busy || dest) return;
    setBusy(true);
    setError(null);
    try {
      const hit = await api.scan(code);
      if (hit.kind === 'equipment') setError('Un equipo no puede ser destino de un contenedor');
      else if (hit.id === c.id) setError('Has escaneado el propio contenedor. Escanea el sitio de destino');
      else {
        setDest(hit);
        setKey(newOperationKey());
        setWarning(null);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (force: boolean) => {
    if (!dest) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.moveContainer(
        c.id,
        { ...(dest.kind === 'location' ? { toLocationId: dest.id } : { toParentContainerId: dest.id }), force },
        key,
      );
      const extra = r.descendantsMoved > 0 ? `, con ${r.descendantsMoved} contenedor${r.descendantsMoved > 1 ? 'es' : ''} dentro` : '';
      props.onDone(`${c.code} movido a ${r.destination}${extra}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CAPACIDAD_SUPERADA') {
        setWarning(e.message);
        setKey(newOperationKey());
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form">
      <h3>Mover {c.code}</h3>
      {!dest ? (
        <>
          <Scanner onCode={onCode} busy={busy} hint="Escanea el QR del sitio de destino: una ubicación u otro contenedor." />
          {error && <p className="alert alert-error">{error}</p>}
          <div className="actions">
            <button className="btn" onClick={props.onCancel}>
              Cancelar
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="confirm">
            Mover <strong>{c.code}</strong> {dest.kind === 'location' ? 'a la ubicación' : 'dentro del contenedor'}{' '}
            <strong>{dest.code}</strong>
            {dest.name ? ` (${dest.name})` : ''}
            {props.detail.children.length > 0 && ', con todo lo que lleva dentro'}.
          </p>
          {warning && <p className="alert alert-warn">{warning}. Puedes moverlo de todos modos.</p>}
          {error && <p className="alert alert-error">{error}</p>}
          <div className="actions">
            <button className="btn" onClick={() => { setDest(null); setError(null); setWarning(null); }} disabled={busy}>
              Otro destino
            </button>
            <button className="btn btn-primary btn-big-inline" onClick={() => confirm(Boolean(warning))} disabled={busy}>
              {busy ? 'Moviendo…' : warning ? 'Mover de todos modos' : 'Confirmar'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function EditContainerForm(props: { detail: ContainerDetail; onCancel: () => void; onDone: () => void }) {
  const c = props.detail.container;
  const [description, setDescription] = useState(c.description ?? '');
  const [reusePolicy, setReusePolicy] = useState(c.reusePolicy);
  const [responsible, setResponsible] = useState(c.responsibleUserId ?? '');
  const [users, setUsers] = useState<Array<{ id: string; fullName: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.basicUsers().then((r) => setUsers(r.users)).catch((e) => setError(errorMessage(e)));
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateContainer(c.id, { description, reusePolicy, responsibleUserId: responsible || null });
      props.onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={save}>
      <h3>Editar {c.code}</h3>
      <label className="field">
        <span>Descripción</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} autoFocus />
      </label>
      <div className="grid-2">
        <label className="field">
          <span>Responsable</span>
          <select value={responsible} onChange={(e) => setResponsible(e.target.value)}>
            <option value="">Sin responsable</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Política</span>
          <select value={reusePolicy} onChange={(e) => setReusePolicy(e.target.value as 'REUSABLE' | 'DISPOSABLE')}>
            <option value="REUSABLE">Reutilizable: conserva su QR al vaciarse</option>
            <option value="DISPOSABLE">Desechable: se retira al vaciarse</option>
          </select>
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

/** Duplicar un contenedor: mismo tipo, descripción, responsable y política, en el mismo sitio. */
function DuplicateContainerForm(props: { detail: ContainerDetail; onCancel: () => void; onDone: (text: string) => void }) {
  const c = props.detail.container;
  const [quantity, setQuantity] = useState('1');
  const [includeChildren, setIncludeChildren] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newOperationKey);

  const create = async (force: boolean, operationKey: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.duplicateContainer(c.id, { quantity: Number(quantity) || 1, includeChildren, force }, operationKey);
      const codes = r.containers.map((k) => k.code);
      props.onDone(`Creado${codes.length > 1 ? 's' : ''}: ${codes.join(', ')}${includeChildren ? ', cada uno con sus contenedores de dentro' : ''}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CAPACIDAD_SUPERADA') setWarning(e.message);
      else setError(errorMessage(e));
      setKey(newOperationKey());
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={(e) => { e.preventDefault(); void create(false, key); }}>
      <h3>Duplicar {c.code}</h3>
      <p className="muted">
        Las copias serán {c.typeName.toLowerCase()}s iguales, en el mismo sitio, cada una con su propio código y QR. El
        material no se copia.
      </p>
      <label className="field">
        <span>Cuántas copias</span>
        <input value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, '').slice(0, 2))} inputMode="numeric" onFocus={(e) => e.target.select()} required autoFocus />
        <small className="muted">Hasta 50 de una vez.</small>
      </label>
      {props.detail.children.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={includeChildren} onChange={(e) => setIncludeChildren(e.target.checked)} />
          <span>
            <strong>Copiar también los contenedores de dentro</strong>
            <small className="muted"> — vacíos, con códigos nuevos</small>
          </span>
        </label>
      )}
      {warning && (
        <div className="alert alert-warn">
          <p>{warning}. ¿Crear de todos modos?</p>
          <button type="button" className="btn" disabled={busy} onClick={() => create(true, key)}>
            Sí, crear de todos modos
          </button>
        </div>
      )}
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Creando…' : 'Crear copias'}
        </button>
      </div>
    </form>
  );
}
