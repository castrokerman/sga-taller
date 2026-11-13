import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api, errorMessage, newOperationKey, ApiError,
  type ContainerType, type LocationDetail, type LocationSummary, type LocationType, type User,
} from '../api';
import { Breadcrumbs, ContainerCard, LabelPanel, LocationCard } from '../components/Common';
import { navigate } from '../router';

type Panel = 'none' | 'location' | 'container' | 'labels' | 'edit' | 'duplicate' | 'export';

export function WarehousePage({ user, locationId }: { user: User; locationId?: string }) {
  const [detail, setDetail] = useState<LocationDetail | null>(null);
  const [roots, setRoots] = useState<LocationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('none');

  const can = (p: string) => user.permissions.includes(p);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (locationId) {
        setDetail(await api.location(locationId));
        setRoots(null);
      } else {
        setRoots((await api.rootLocations()).locations);
        setDetail(null);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [locationId]);

  useEffect(() => {
    setPanel('none');
    setNotice(null);
    setDetail(null);
    setRoots(null);
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

  const loc = detail?.location;
  const children = detail?.children ?? roots ?? [];
  const containers = detail?.containers ?? [];

  return (
    <>
      <Breadcrumbs locations={detail?.path ?? []} current={locationId} />

      <div className="page-head">
        <div>
          <h2>{loc ? loc.code : 'Almacén'}</h2>
          {loc && (
            <p className="muted nomargin">
              {loc.name} · {loc.typeName}
              {loc.maxCapacity !== null && ` · ${loc.containerCount} de ${loc.maxCapacity} contenedores`}
            </p>
          )}
        </div>
        <button className="btn btn-primary push-right" onClick={() => navigate('escaner')}>
          Escanear
        </button>
      </div>

      {loc && loc.maxCapacity !== null && loc.containerCount > loc.maxCapacity && (
        <p className="alert alert-warn">Esta ubicación supera su capacidad de {loc.maxCapacity} contenedores.</p>
      )}
      {notice && <p className="alert alert-ok">{notice}</p>}
      {error && <p className="alert alert-error">{error}</p>}

      <div className="toolbar">
        {can('location.manage') && (
          <button className="btn" onClick={() => open('location')}>
            {loc ? 'Nueva ubicación dentro' : 'Nueva ubicación'}
          </button>
        )}
        {loc && can('container.manage') && (
          <button className="btn" onClick={() => open('container')}>
            Nuevo contenedor aquí
          </button>
        )}
        {can('label.print') && (loc || children.length > 0) && (
          <button className="btn" onClick={() => open('labels')}>
            Etiquetas QR
          </button>
        )}
        {loc && can('location.manage') && (
          <button className="btn" onClick={() => open('edit')}>
            Editar
          </button>
        )}
        {loc && can('location.manage') && (
          <button className="btn" onClick={() => open('duplicate')}>
            Duplicar
          </button>
        )}
        {!loc && (
          <button className="btn" onClick={() => open('export')}>
            Exportar a Excel
          </button>
        )}
      </div>

      {panel === 'location' && (
        <LocationForm parent={loc} onCancel={() => setPanel('none')} onDone={(l) => done(`Ubicación creada: ${l.code}`)} />
      )}
      {panel === 'container' && loc && (
        <ContainerForm
          where={{ locationId: loc.id }}
          onCancel={() => setPanel('none')}
          onDone={(codes) => done(`Creado${codes.length > 1 ? 's' : ''}: ${codes.join(', ')}`)}
        />
      )}
      {panel === 'edit' && loc && (
        <EditLocationForm location={loc} onCancel={() => setPanel('none')} onDone={(text) => done(text)} onGone={() => navigate(loc.parentId ? `almacen/${loc.parentId}` : 'almacen')} />
      )}
      {panel === 'duplicate' && loc && (
        <DuplicateLocationForm location={loc} onCancel={() => setPanel('none')} onDone={(text) => done(text)} />
      )}
      {panel === 'export' && <ExportPanel onClose={() => setPanel('none')} />}
      {panel === 'labels' && (
        <LabelPanel
          onClose={() => setPanel('none')}
          groups={[
            { label: 'Esta ubicación', items: loc ? [{ kind: 'location', id: loc.id }] : [] },
            { label: loc ? 'Ubicaciones de dentro' : 'Todas las de esta lista', items: children.map((c) => ({ kind: 'location' as const, id: c.id })) },
            { label: 'Contenedores de aquí', items: containers.map((c) => ({ kind: 'container' as const, id: c.id })) },
          ]}
        />
      )}

      {!detail && !roots && !error && <p className="muted">Cargando…</p>}

      {children.length > 0 && (
        <section>
          <h3>Ubicaciones</h3>
          <div className="items">
            {children.map((l) => (
              <LocationCard key={l.id} l={l} />
            ))}
          </div>
        </section>
      )}

      {loc && (
        <section>
          <h3>Contenedores</h3>
          {containers.length > 0 ? (
            <div className="items">
              {containers.map((c) => (
                <ContainerCard key={c.id} c={c} />
              ))}
            </div>
          ) : (
            <p className="muted">No hay contenedores colocados directamente aquí.</p>
          )}
        </section>
      )}

      {roots && roots.length === 0 && (
        <p className="alert alert-info">
          El almacén está vacío. Empieza creando las zonas principales, por ejemplo «COM» para la zona común y
          «ALM-A» para el almacén principal.
        </p>
      )}
    </>
  );
}

function LocationForm(props: { parent?: LocationSummary; onCancel: () => void; onDone: (l: LocationSummary) => void }) {
  const [types, setTypes] = useState<LocationType[]>([]);
  const [code, setCode] = useState(props.parent ? `${props.parent.code}-` : '');
  const [name, setName] = useState('');
  const [typeCode, setTypeCode] = useState('');
  const [capacity, setCapacity] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.locationTypes().then((r) => {
      const active = r.types.filter((t) => t.active);
      setTypes(active);
      setTypeCode((current) => current || active[0]?.code || '');
    }).catch((e) => setError(errorMessage(e)));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.createLocation({
        code: code.trim().toUpperCase(), name, typeCode, parentId: props.parent?.id,
        maxCapacity: capacity ? Number(capacity) : undefined,
      });
      props.onDone(r.location);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h3>{props.parent ? `Nueva ubicación dentro de ${props.parent.code}` : 'Nueva ubicación'}</h3>
      <div className="grid-2">
        <label className="field">
          <span>Código</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            required
            autoFocus
            pattern="[A-Z0-9][A-Z0-9\-]{0,39}"
            autoCapitalize="characters"
            spellCheck={false}
          />
          <small className="muted">Mayúsculas, números y guiones. Ejemplo: ALM-A-P01-E01.</small>
        </label>
        <label className="field">
          <span>Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        <label className="field">
          <span>Tipo</span>
          <select value={typeCode} onChange={(e) => setTypeCode(e.target.value)} required>
            {types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Capacidad (opcional)</span>
          <input value={capacity} onChange={(e) => setCapacity(e.target.value.replace(/\D/g, ''))} inputMode="numeric" onFocus={(e) => e.target.select()} />
          <small className="muted">Número máximo de contenedores. Si se supera, el sistema avisa.</small>
        </label>
      </div>
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={busy || !typeCode}>
          Crear ubicación
        </button>
      </div>
    </form>
  );
}

function EditLocationForm(props: { location: LocationSummary; onCancel: () => void; onDone: (text: string) => void; onGone: () => void }) {
  const { location } = props;
  const [code, setCode] = useState(location.code);
  const [name, setName] = useState(location.name);
  const [capacity, setCapacity] = useState(location.maxCapacity?.toString() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateLocation(location.id, { code: code.trim().toUpperCase(), name, maxCapacity: capacity ? Number(capacity) : null });
      props.onDone('Cambios guardados');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    if (!window.confirm(`¿Desactivar la ubicación ${location.code}? Dejará de aparecer en el almacén.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateLocation(location.id, { active: false });
      props.onGone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={save}>
      <h3>Editar {location.code}</h3>
      <div className="grid-2">
        <label className="field">
          <span>Código</span>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required pattern="[A-Z0-9][A-Z0-9\-]{0,39}" spellCheck={false} />
          <small className="muted">Cambiar el código no cambia el QR: la etiqueta pegada sigue valiendo.</small>
        </label>
        <label className="field">
          <span>Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        <label className="field">
          <span>Capacidad (opcional)</span>
          <input value={capacity} onChange={(e) => setCapacity(e.target.value.replace(/\D/g, ''))} inputMode="numeric" onFocus={(e) => e.target.select()} />
        </label>
      </div>
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn btn-danger" onClick={deactivate} disabled={busy}>
          Desactivar
        </button>
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

/** Alta de uno o varios contenedores en una ubicación o dentro de otro contenedor. */
export function ContainerForm(props: {
  where: { locationId?: string; parentContainerId?: string };
  onCancel: () => void;
  onDone: (codes: string[]) => void;
}) {
  const [types, setTypes] = useState<ContainerType[]>([]);
  const [typeCode, setTypeCode] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newOperationKey);

  useEffect(() => {
    api.containerTypes().then((r) => {
      const active = r.types.filter((t) => t.active);
      setTypes(active);
      setTypeCode((current) => current || active[0]?.code || '');
    }).catch((e) => setError(errorMessage(e)));
  }, []);

  const create = async (force: boolean, operationKey: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createContainers(
        { typeCode, quantity: Number(quantity) || 1, description: description || undefined, force, ...props.where },
        operationKey,
      );
      props.onDone(r.containers.map((c) => c.code));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CAPACIDAD_SUPERADA') {
        setWarning(err.message);
        setKey(newOperationKey()); // forzar es otra operación distinta
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={(e) => { e.preventDefault(); void create(false, key); }}>
      <h3>Nuevo contenedor</h3>
      <div className="grid-2">
        <label className="field">
          <span>Tipo</span>
          <select value={typeCode} onChange={(e) => setTypeCode(e.target.value)} required autoFocus>
            {types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name} ({t.codePrefix})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Cuántos</span>
          <input value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, '').slice(0, 3))} inputMode="numeric" onFocus={(e) => e.target.select()} required />
          <small className="muted">Hasta 100 de una vez. Cada uno recibe su código y su QR.</small>
        </label>
      </div>
      <label className="field">
        <span>Descripción (opcional)</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
      </label>

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
        <button className="btn btn-primary" disabled={busy || !typeCode}>
          Crear
        </button>
      </div>
    </form>
  );
}

/** Duplicar una ubicación: mismo tipo, capacidad y restricciones, en el mismo sitio y con QR nuevo. */
function DuplicateLocationForm(props: { location: LocationSummary; onCancel: () => void; onDone: (text: string) => void }) {
  const { location } = props;
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [proposal, setProposal] = useState<Awaited<ReturnType<typeof api.locationDuplicateProposal>> | null>(null);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newOperationKey);

  useEffect(() => {
    api.locationDuplicateProposal(location.id).then((p) => {
      setProposal(p);
      setCode(p.code);
      setName(p.name);
      setIncludeChildren(p.childrenCopyable && p.descendantCount > 0);
    }).catch((e) => setError(errorMessage(e)));
  }, [location.id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.duplicateLocation(location.id, { code: code.trim().toUpperCase(), name, includeChildren }, key);
      const extra = r.created > 1 ? `, con ${r.created - 1} ubicaciones dentro` : '';
      props.onDone(`Creada ${r.location.code}${extra}. Puedes volver a duplicar para crear la siguiente.`);
    } catch (err) {
      setError(errorMessage(err));
      setKey(newOperationKey());
    } finally {
      setBusy(false);
    }
  };

  const n = proposal?.descendantCount ?? 0;

  return (
    <form className="card form" onSubmit={submit}>
      <h3>Duplicar {location.code}</h3>
      <p className="muted">
        La copia tendrá el mismo tipo, capacidad y restricciones, y estará en el mismo sitio. Su etiqueta QR será nueva.
      </p>
      <div className="grid-2">
        <label className="field">
          <span>Código de la copia</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            required
            autoFocus
            pattern="[A-Z0-9][A-Z0-9\-]{0,39}"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
      </div>

      {n > 0 && (
        <label className="check">
          <input
            type="checkbox"
            checked={includeChildren}
            disabled={!proposal?.childrenCopyable}
            onChange={(e) => setIncludeChildren(e.target.checked)}
          />
          <span>
            <strong>Copiar también las {n} ubicaciones de dentro</strong>
            <small className="muted">
              {proposal?.childrenCopyable
                ? ` — sus códigos cambiarán de ${location.code}-… a ${code || '…'}-…`
                : proposal?.blockingChildCode
                  ? ` — no se puede: ${proposal.blockingChildCode} no empieza por ${location.code}`
                  : ' — no se puede: son demasiadas'}
            </small>
          </span>
        </label>
      )}
      <p className="muted small">Los contenedores no se copian.</p>

      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={busy || !proposal}>
          {busy ? 'Creando…' : 'Crear copia'}
        </button>
      </div>
    </form>
  );
}

/** Descarga de ubicaciones y contenedores en ficheros de Excel. */
function ExportPanel(props: { onClose: () => void }) {
  return (
    <div className="card form">
      <h3>Exportar a Excel</h3>
      <p className="muted">Se descarga un fichero .xlsx con todo el almacén, tal como está ahora.</p>
      <div className="stack">
        <a className="btn" href="/api/export/ubicaciones.xlsx" download>
          Ubicaciones
        </a>
        <a className="btn" href="/api/export/contenedores.xlsx" download>
          Contenedores
        </a>
      </div>
      <p className="muted small">Es una copia para consultar. Los cambios hechos en el Excel no vuelven al sistema.</p>
      <div className="actions">
        <button className="btn" onClick={props.onClose}>
          Cerrar
        </button>
      </div>
    </div>
  );
}
