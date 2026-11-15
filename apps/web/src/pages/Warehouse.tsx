import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api, errorMessage, newOperationKey, ApiError,
  type ContainerSummary, type ContainerType, type LocationDetail, type LocationSummary, type LocationType, type User,
} from '../api';
import { Breadcrumbs, ContainerCard, containerListConfig, LabelPanel, LocationCard, locationListConfig, ViewSwitch } from '../components/Common';
import { useListControls } from '../components/ListControls';
import { StockSection } from '../components/Stock';
import { MoveContainersPanel } from '../components/MoveContainers';
import { Thumb } from '../components/Thumb';
import { ItemExtras } from '../components/ItemExtras';
import { BulkEditor, CodeInput, padSeq, SeqInput, type BulkChanges } from '../components/BulkEditor';
import { WarehouseTree } from './Tree';
import { navigate } from '../router';

type Panel = 'none' | 'location' | 'container' | 'labels' | 'edit' | 'duplicate' | 'export' | 'bulk-loc' | 'bulk-cont' | 'move-cont';

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
  const locList = useListControls(children, locationListConfig(children, 'ubicaciones'));
  const contList = useListControls(containers, containerListConfig(containers, 'contenedores'));

  // En la raíz del almacén se puede elegir entre la lista y el árbol completo.
  const [view, setView] = useState<'lista' | 'arbol'>(() => {
    try {
      return window.localStorage.getItem('sga.vista-almacen') === 'arbol' ? 'arbol' : 'lista';
    } catch {
      return 'lista';
    }
  });
  const chooseView = (v: 'lista' | 'arbol') => {
    setView(v);
    try {
      window.localStorage.setItem('sga.vista-almacen', v);
    } catch {
      /* sin almacenamiento local */
    }
  };
  // Dentro de una ubicación, el árbol muestra solo lo que cuelga de ella.
  const hasInside = Boolean(loc && (loc.childCount > 0 || loc.containerCount > 0));
  const localTree = Boolean(loc && hasInside && view === 'arbol');
  if (!locationId && view === 'arbol') {
    return <WarehouseTree user={user} onList={() => chooseView('lista')} />;
  }

  return (
    <>
      <Breadcrumbs locations={detail?.path ?? []} current={locationId} />

      <div className="page-head">
        {loc?.photoId && (
          <span className="head-thumb">
            <Thumb photoId={loc.photoId} />
          </span>
        )}
        <div>
          <h2>{loc ? loc.code : 'Almacén'}</h2>
          {loc && (
            <p className="muted nomargin">
              {loc.name} · {loc.typeName} · {loc.holdsContent ? 'guarda contenido' : 'solo contenedores'}
              {loc.maxCapacity !== null && ` · ${loc.containerCount} de ${loc.maxCapacity} contenedores`}
            </p>
          )}
        </div>
        {(!loc || hasInside) && <ViewSwitch view={loc ? view : 'lista'} onChange={chooseView} />}
        <button className={`btn btn-primary ${loc ? 'push-right' : ''}`} onClick={() => navigate('escaner')}>
          Escanear
        </button>
      </div>

      {loc && loc.maxCapacity !== null && loc.containerCount > loc.maxCapacity && (
        <p className="alert alert-warn">Esta ubicación supera su capacidad de {loc.maxCapacity} contenedores.</p>
      )}
      {notice && <p className="alert alert-ok">{notice}</p>}
      {error && <p className="alert alert-error">{error}</p>}
      {!loc && can('location.manage') && <RecodeNotice onDone={done} />}

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
        <LocationForm parent={loc} siblings={children} onCancel={() => setPanel('none')} onDone={(l) => done(`Ubicación creada: ${l.code}`)} />
      )}
      {panel === 'container' && loc && (
        <ContainerForm
          where={{ locationId: loc.id }}
          allowed={loc.allowedContainerTypes}
          onCancel={() => setPanel('none')}
          onDone={(codes) => done(`Creado${codes.length > 1 ? 's' : ''}: ${codes.join(', ')}`)}
        />
      )}
      {panel === 'edit' && loc && (
        <EditLocationForm location={loc} canDeactivate={can('location.deactivate')} onCancel={() => setPanel('none')} onDone={(text) => done(text)} onGone={() => navigate(loc.parentId ? `almacen/${loc.parentId}` : 'almacen')} />
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

      {localTree && loc && <WarehouseTree key={loc.id} user={user} rootId={loc.id} onList={() => chooseView('lista')} />}

      {!localTree && children.length > 0 && (
        <section>
          <div className="section-head">
            <h3>Ubicaciones</h3>
            {can('location.manage') && children.length > 1 && (
              <button className="btn btn-small push-right" onClick={() => open('bulk-loc')}>
                Editar en tabla
              </button>
            )}
          </div>
          {panel === 'bulk-loc' && (
            <BulkLocations rows={locList.visible} canDeactivate={can('location.deactivate')} onClose={(m) => (m ? done(m) : setPanel('none'))} />
          )}
          {children.length > 1 && locList.bar}
          <div className="items">
            {locList.visible.map((l) => (
              <LocationCard key={l.id} l={l} q={locList.query} />
            ))}
          </div>
          {locList.visible.length === 0 && <p className="muted">Ninguna ubicación cumple los filtros.</p>}
        </section>
      )}

      {loc && !localTree && (
        <section>
          <div className="section-head">
            <h3>Contenedores</h3>
            {can('container.move') && containers.length > 0 && (
              <button className="btn btn-small push-right" onClick={() => open('move-cont')}>
                Mover
              </button>
            )}
            {can('container.manage') && containers.length > 1 && (
              <button className={`btn btn-small ${can('container.move') ? '' : 'push-right'}`} onClick={() => open('bulk-cont')}>
                Editar en tabla
              </button>
            )}
          </div>
          {panel === 'move-cont' && loc && (
            <MoveFromHere containers={containers} from={loc.id} onCancel={() => setPanel('none')} onDone={done} />
          )}
          {panel === 'bulk-cont' && (
            <BulkContainers rows={contList.visible} onClose={(m) => (m ? done(m) : setPanel('none'))} />
          )}
          {containers.length > 0 ? (
            <>
              {containers.length > 1 && contList.bar}
              <div className="items">
                {contList.visible.map((c) => (
                  <ContainerCard key={c.id} c={c} q={contList.query} />
                ))}
              </div>
              {contList.visible.length === 0 && <p className="muted">Ningún contenedor cumple los filtros.</p>}
            </>
          ) : (
            <p className="muted">No hay contenedores colocados directamente aquí.</p>
          )}
        </section>
      )}

      {loc && <StockSection user={user} place={{ locationId: loc.id }} placeCode={loc.code} active={loc.active} holdsContent={loc.holdsContent} onChanged={() => void load()} />}
      {loc && <ItemExtras user={user} entityType="location" entityId={loc.id} onPhotosChanged={() => void load()} />}

      {roots && roots.length === 0 && (
        <p className="alert alert-info">
          El almacén está vacío. Empieza creando las zonas principales, por ejemplo «COM» para la zona común y
          «ALM-A» para el almacén principal.
        </p>
      )}
    </>
  );
}

/** Lo que suele ir dentro de cada tipo, si aún no hay nada dentro. */
const USUAL_CHILD: Record<string, string> = {
  ZONA: 'PASILLO', AREA: 'ESTANTERIA', PASILLO: 'ESTANTERIA', ESTANTERIA: 'NIVEL', ARMARIO: 'NIVEL', NIVEL: 'POSICION', CAJONERA: 'CAJON',
};

function LocationForm(props: { parent?: LocationSummary; siblings?: LocationSummary[]; onCancel: () => void; onDone: (l: LocationSummary) => void }) {
  const [types, setTypes] = useState<LocationType[]>([]);
  const [code, setCode] = useState('');
  const [seq, setSeq] = useState('');
  const [name, setName] = useState('');
  const [typeCode, setTypeCode] = useState('');
  const [capacity, setCapacity] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parent = props.parent;

  useEffect(() => {
    api.locationTypes().then((r) => {
      const active = r.types.filter((t) => t.active);
      setTypes(active);
      // En primer nivel, una zona. Dentro de otra: el tipo que más tienen ya sus hermanas o, si no hay, el que suele ir debajo.
      const has = (code?: string) => (code && active.some((t) => t.code === code) ? code : undefined);
      const counts = new Map<string, number>();
      for (const s of props.siblings ?? []) counts.set(s.typeCode, (counts.get(s.typeCode) ?? 0) + 1);
      const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const suggested = !parent
        ? has('ZONA')
        : has(common) ?? has(USUAL_CHILD[parent.typeCode]) ?? active.find((t) => t.code !== 'ZONA')?.code;
      setTypeCode((current) => current || suggested || active[0]?.code || '');
    }).catch((e) => setError(errorMessage(e)));
  }, [parent]);

  // Dentro de otra: el siguiente número libre para ese tipo.
  useEffect(() => {
    if (!parent || !typeCode) return;
    api.nextLocationCode(parent.id, typeCode).then((r) => setSeq(String(r.seq))).catch(() => undefined);
  }, [parent, typeCode]);
  const typePrefix = types.find((t) => t.code === typeCode)?.codePrefix ?? '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.createLocation({
        ...(parent ? { seq: Number(seq) } : { segment: code.trim() }), name, typeCode, parentId: parent?.id,
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
          <span>Código</span>
          {parent ? (
            <SeqInput fixed={`${parent.code}-${typePrefix}`} value={seq} onChange={setSeq} />
          ) : (
            <CodeInput prefix={null} value={code} onChange={setCode} />
          )}
          <small className="muted">
            {parent
              ? `Quedará ${parent.code}-${typePrefix}${padSeq(seq)}. El principio lo ponen la ubicación superior y el tipo; se propone el siguiente número libre.`
              : 'Zona de primer nivel: código libre, con mayúsculas, números y guiones. Ejemplo: ALM-A.'}
          </small>
        </label>
        <label className="field">
          <span>Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
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
        <button className="btn btn-primary" disabled={busy || !typeCode || (parent ? !seq : !code)}>
          Crear ubicación
        </button>
      </div>
    </form>
  );
}

function EditLocationForm(props: { location: LocationSummary; canDeactivate: boolean; onCancel: () => void; onDone: (text: string) => void; onGone: () => void }) {
  const { location } = props;
  const nested = Boolean(location.parentId);
  const [code, setCode] = useState(location.segment);
  const [seq, setSeq] = useState(String(location.seq ?? Number(/(\d+)$/.exec(location.segment)?.[1] ?? '') ?? ''));
  const [types, setTypes] = useState<LocationType[]>([]);
  const [typeCode, setTypeCode] = useState(location.typeCode);
  useEffect(() => {
    api.locationTypes().then((r) => setTypes(r.types.filter((t) => t.active || t.code === location.typeCode))).catch(() => undefined);
  }, [location.typeCode]);
  const typePrefix = types.find((t) => t.code === typeCode)?.codePrefix ?? location.typePrefix;
  const [name, setName] = useState(location.name);
  const [capacity, setCapacity] = useState(location.maxCapacity?.toString() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.deleteLocation(location.id);
      void r;
      props.onGone();
    } catch (err) {
      setError(errorMessage(err));
      setConfirmDelete(false);
      setBusy(false);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.updateLocation(location.id, {
        ...(nested ? { seq: Number(seq), typeCode } : { segment: code.trim() }),
        name, maxCapacity: capacity ? Number(capacity) : null,
      });
      props.onDone(
        r.descendantsRecoded > 0
          ? `Código cambiado a ${r.location.code}, y también el de las ${r.descendantsRecoded} ubicaciones de dentro. Las etiquetas pegadas siguen funcionando, pero muestran el código anterior: conviene reimprimirlas.`
          : r.location.code !== location.code
            ? `Código cambiado a ${r.location.code}. La etiqueta pegada sigue funcionando, pero muestra el código anterior.`
            : 'Cambios guardados',
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    const on = !location.active;
    if (!window.confirm(on
      ? `¿Volver a activar ${location.code}?`
      : `¿Desactivar la ubicación ${location.code}? Seguirá viéndose, en gris, pero no admitirá contenedores ni contenido nuevos.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateLocation(location.id, { active: on });
      props.onDone(on ? `${location.code} vuelve a estar activa` : `${location.code} desactivada. Se sigue viendo en gris.`);
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
          {nested ? (
            <SeqInput fixed={`${location.parentCode}-${typePrefix}`} value={seq} onChange={setSeq} />
          ) : (
            <CodeInput prefix={null} value={code} onChange={setCode} />
          )}
          <small className="muted">
            {location.childCount > 0 ? 'Si lo cambias, cambia también el de todas las ubicaciones de dentro. ' : ''}
            El QR no cambia: las etiquetas pegadas siguen valiendo.
          </small>
        </label>
        <label className="field">
          <span>Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        {nested && (
          <label className="field">
            <span>Tipo</span>
            <select value={typeCode} onChange={(e) => setTypeCode(e.target.value)}>
              {types.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name} ({t.codePrefix})
                </option>
              ))}
            </select>
            <small className="muted">Cambiar el tipo cambia el prefijo del código.</small>
          </label>
        )}
        <label className="field">
          <span>Capacidad (opcional)</span>
          <input value={capacity} onChange={(e) => setCapacity(e.target.value.replace(/\D/g, ''))} inputMode="numeric" onFocus={(e) => e.target.select()} />
        </label>
      </div>
      {error && <p className="alert alert-error">{error}</p>}
      {confirmDelete && (
        <div className="danger-confirm" role="alertdialog" aria-labelledby="del-title">
          <strong id="del-title">¿Seguro que quieres eliminar la ubicación {location.code}?</strong>
          <p>
            Desaparece del sistema y no se puede deshacer. Su etiqueta QR dejará de funcionar. Solo se puede si está vacía y no
            tiene historial; si no, desactívala.
          </p>
          <div className="actions nomargin">
            <button type="button" className="btn" onClick={() => setConfirmDelete(false)} disabled={busy} autoFocus>
              No, volver
            </button>
            <button type="button" className="btn btn-delete" onClick={remove} disabled={busy}>
              {busy ? 'Eliminando…' : 'Sí, eliminar'}
            </button>
          </div>
        </div>
      )}
      <div className="actions actions-wrap">
        {props.canDeactivate && (
          <button type="button" className="btn btn-delete-ghost" onClick={() => setConfirmDelete(true)} disabled={busy || confirmDelete}>
            🗑 Eliminar
          </button>
        )}
        {props.canDeactivate && (
          <button type="button" className={`btn ${location.active ? 'btn-warn' : ''}`} onClick={deactivate} disabled={busy}>
            {location.active ? 'Desactivar' : 'Volver a activar'}
          </button>
        )}
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
  /** Tipos admitidos por la ubicación (vacío o sin dar: cualquiera). */
  allowed?: string[];
  onCancel: () => void;
  onDone: (codes: string[]) => void;
}) {
  const [types, setTypes] = useState<ContainerType[]>([]);
  const [typeCode, setTypeCode] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [contentDescription, setContentDescription] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newOperationKey);

  useEffect(() => {
    api.containerTypes().then((r) => {
      const allowed = props.allowed ?? [];
      const active = r.types.filter((t) => t.active && (allowed.length === 0 || allowed.includes(t.code)));
      setTypes(active);
      setTypeCode((current) => current || active[0]?.code || '');
    }).catch((e) => setError(errorMessage(e)));
  }, []);

  const create = async (force: boolean, operationKey: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createContainers(
        { typeCode, quantity: Number(quantity) || 1, description: description || undefined, contentDescription: contentDescription.trim() || undefined, force, ...props.where },
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
      <label className="field">
        <span>Descripción del contenido (opcional)</span>
        <input value={contentDescription} onChange={(e) => setContentDescription(e.target.value)} maxLength={300} placeholder="Qué lleva dentro: tornillería M6, retales de chapa…" />
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
      setCode(p.seq ? String(p.seq) : p.segment);
      setName(p.name);
      setIncludeChildren(p.childrenCopyable && p.descendantCount > 0);
    }).catch((e) => setError(errorMessage(e)));
  }, [location.id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.duplicateLocation(
        location.id, { ...(proposal?.seq ? { seq: Number(code) } : { segment: code.trim() }), name, includeChildren }, key,
      );
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
          {proposal?.seq ? (
            <SeqInput fixed={`${location.parentCode}-${proposal.typePrefix}`} value={code} onChange={setCode} autoFocus />
          ) : (
            <CodeInput prefix={location.parentCode} value={code} onChange={setCode} autoFocus />
          )}
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
                ? ` — con códigos ${location.parentCode ? `${location.parentCode}-` : ''}${code || '…'}-…`
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
      <p className="muted">Se descarga un fichero .xlsx con todo, tal como está ahora.</p>
      <div className="stack">
        <a className="btn" href="/api/export/ubicaciones.xlsx" download>
          Ubicaciones
        </a>
        <a className="btn" href="/api/export/contenedores.xlsx" download>
          Contenedores
        </a>
        <a className="btn" href="/api/export/materiales.xlsx" download>
          Contenidos
        </a>
        <a className="btn" href="/api/export/stock.xlsx" download>
          Stock por sitio
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


/** Edición en tabla de las ubicaciones de la lista (las que se ven con los filtros puestos). */
export function BulkLocations(props: {
  rows: LocationSummary[];
  canDeactivate: boolean;
  depth?: (l: LocationSummary) => number;
  hint?: string;
  onClose: (message?: string) => void;
}) {
  const [types, setTypes] = useState<LocationType[]>([]);
  useEffect(() => {
    api.locationTypes().then((r) => setTypes(r.types)).catch(() => undefined);
  }, []);
  if (!types.length) return <p className="muted">Cargando…</p>;

  const save = async (changes: BulkChanges) => {
    const items = changes.map(({ id, values }) => {
      const item: Record<string, unknown> & { id: string } = { id };
      const row = props.rows.find((l) => l.id === id)!;
      for (const [k, v] of Object.entries(values)) {
        if (k === 'segment') {
          if (row.parentId) {
            if (!/^\d{1,4}$/.test(String(v)) || Number(v) < 1) throw new Error(`${row.code}: escribe solo el número`);
            item.seq = Number(v);
          } else item.segment = String(v);
        } else if (k === 'capacity') item.maxCapacity = v === '' ? null : Number(v);
        else if (k === 'description') item.description = String(v);
        else item[k] = v;
      }
      return item;
    });
    const r = await api.bulkLocations(items);
    return `Guardados los cambios de ${items.length} ubicaci${items.length > 1 ? 'ones' : 'ón'}` +
      (r.descendantsRecoded ? `. También ha cambiado el código de ${r.descendantsRecoded} ubicaciones de dentro: conviene reimprimir sus etiquetas` : '');
  };

  return (
    <BulkEditor
      title={`Editar ${props.rows.length} ubicaciones`}
      hint={props.hint ?? 'Se editan las que se ven en la lista: usa los filtros para elegir cuáles. Lo cambiado se marca en amarillo y se guarda todo junto; si algo falla, no se guarda nada.'}
      rows={props.rows}
      onSave={save}
      onClose={props.onClose}
      columns={[
        { key: 'segment', label: 'Código', type: 'segment', indent: props.depth, width: '190px',
          // Dentro de otra: fijos el código de la superior y el prefijo del tipo; se edita el número.
          get: (l) => (l.parentId ? String((l.seq ?? Number(/(\d+)$/.exec(l.segment)?.[1] ?? 0)) || '') : l.segment),
          prefix: (l) => (l.parentId ? `${l.parentCode}-${l.typePrefix}` : null) },
        { key: 'name', label: 'Nombre', type: 'text', get: (l) => l.name, width: '200px' },
        { key: 'typeCode', label: 'Tipo', type: 'select', required: true, fillAll: true, get: (l) => l.typeCode,
          options: types.filter((t) => t.active).map((t) => ({ value: t.code, label: t.name })), width: '140px' },
        { key: 'capacity', label: 'Capacidad', type: 'number', fillAll: true, get: (l) => (l.maxCapacity === null ? '' : String(l.maxCapacity)), width: '90px', placeholder: 'Sin límite' },
        { key: 'description', label: 'Descripción', type: 'text', fillAll: true, get: (l) => l.description ?? '', width: '200px' },
        ...(props.canDeactivate ? [{ key: 'active', label: 'Activa', type: 'check' as const, get: (l: LocationSummary) => l.active }] : []),
      ]}
    />
  );
}

/** Edición en tabla de los contenedores de la lista. */
export function BulkContainers(props: { rows: ContainerSummary[]; hint?: string; onClose: (message?: string) => void }) {
  const [users, setUsers] = useState<Array<{ id: string; fullName: string }> | null>(null);
  useEffect(() => {
    api.basicUsers().then((r) => setUsers(r.users)).catch(() => setUsers([]));
  }, []);
  if (!users) return <p className="muted">Cargando…</p>;

  const save = async (changes: BulkChanges) => {
    const items = changes.map(({ id, values }) => {
      const item: Record<string, unknown> & { id: string } = { id };
      if ('description' in values) item.description = String(values.description);
      if ('responsible' in values) item.responsibleUserId = values.responsible === '' ? null : values.responsible;
      if ('reusePolicy' in values) item.reusePolicy = values.reusePolicy;
      return item;
    });
    await api.bulkContainers(items);
    return `Guardados los cambios de ${items.length} contenedor${items.length > 1 ? 'es' : ''}`;
  };

  return (
    <BulkEditor
      title={`Editar ${props.rows.length} contenedores`}
      hint={props.hint ?? 'Se editan los que se ven en la lista: usa los filtros para elegir cuáles. El código de un contenedor no cambia.'}
      rows={props.rows}
      onSave={save}
      onClose={props.onClose}
      columns={[
        { key: 'code', label: 'Código', type: 'static', get: (c) => c.code },
        { key: 'type', label: 'Tipo', type: 'static', get: (c) => c.typeName },
        { key: 'description', label: 'Descripción', type: 'text', fillAll: true, get: (c) => c.description ?? '', width: '240px' },
        { key: 'responsible', label: 'Responsable', type: 'select', fillAll: true, get: (c) => c.responsibleUserId ?? '',
          options: users.map((u) => ({ value: u.id, label: u.fullName })), width: '200px' },
        { key: 'reusePolicy', label: 'Política', type: 'select', required: true, fillAll: true, get: (c) => c.reusePolicy,
          options: [{ value: 'REUSABLE', label: 'Reutilizable' }, { value: 'DISPOSABLE', label: 'Desechable' }], width: '140px' },
      ]}
    />
  );
}

/** Aviso de ubicaciones antiguas cuyo código no sigue el de la superior, con los cambios y el botón para aplicarlos. */
function RecodeNotice(props: { onDone: (text: string) => void }) {
  const [changes, setChanges] = useState<Awaited<ReturnType<typeof api.recodePreview>>['changes'] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.recodePreview().then((r) => setChanges(r.changes)).catch(() => setChanges([]));
  }, []);
  if (!changes || changes.length === 0) return null;
  const blocked = changes.filter((c) => c.conflictWith);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.recode(newOperationKey());
      setChanges([]);
      props.onDone(`Recodificadas ${r.recoded} ubicaciones. Sus etiquetas pegadas siguen funcionando; conviene reimprimirlas para que muestren el código nuevo.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="alert alert-warn">
      <p>
        Hay {changes.length} ubicaci{changes.length > 1 ? 'ones' : 'ón'} cuyo código no sigue la codificación: el código de
        la ubicación que la contiene, el prefijo de su tipo y un número. Al recodificarlas se conserva su número (E01 →
        EST01). No se cambia nada hasta que pulses «Recodificar».
      </p>
      {!open ? (
        <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
          Ver los cambios
        </button>
      ) : (
        <>
          <div className="table-wrap card recode-list">
            <table>
              <thead>
                <tr>
                  <th>Ahora</th>
                  <th>Pasará a</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.code}</td>
                    <td className="mono">
                      <strong>{c.newCode}</strong>
                      {c.conflictWith && <span className="over"> · ya existe</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {blocked.length > 0 && (
            <p>Antes hay que cambiar a mano las que chocan con un código que ya existe.</p>
          )}
          {error && <p className="alert alert-error">{error}</p>}
          <div className="actions">
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Ahora no
            </button>
            <button type="button" className="btn btn-primary" disabled={busy || blocked.length > 0} onClick={apply}>
              {busy ? 'Aplicando…' : `Recodificar ${changes.length}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Mover desde la ubicación: se marcan los contenedores y se elige el destino en la lista. */
function MoveFromHere(props: { containers: ContainerSummary[]; from: string; onCancel: () => void; onDone: (text: string) => void }) {
  const [picked, setPicked] = useState<string[]>(props.containers.length === 1 ? [props.containers[0]!.id] : []);
  const [ready, setReady] = useState(props.containers.length === 1);
  const chosen = props.containers.filter((c) => picked.includes(c.id));
  if (ready && chosen.length) {
    return (
      <MoveContainersPanel
        containers={chosen.map((c) => ({ id: c.id, code: c.code, typeCode: c.typeCode, hasInside: c.childCount > 0 }))}
        from={props.from}
        onCancel={props.containers.length === 1 ? props.onCancel : () => setReady(false)}
        onDone={props.onDone}
      />
    );
  }
  const all = picked.length === props.containers.length;
  return (
    <div className="card form">
      <h3>¿Qué contenedores mueves?</h3>
      <label className="check">
        <input type="checkbox" checked={all} onChange={() => setPicked(all ? [] : props.containers.map((c) => c.id))} />
        <span>Todos ({props.containers.length})</span>
      </label>
      <div className="move-pick">
        {props.containers.map((c) => (
          <label key={c.id} className="check">
            <input
              type="checkbox"
              checked={picked.includes(c.id)}
              onChange={() => setPicked(picked.includes(c.id) ? picked.filter((x) => x !== c.id) : [...picked, c.id])}
            />
            <span>
              <strong className="mono">{c.code}</strong> {c.description ? `· ${c.description}` : ''} <span className="muted">({c.typeName})</span>
            </span>
          </label>
        ))}
      </div>
      <div className="actions">
        <button className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={!picked.length} onClick={() => setReady(true)}>
          Elegir destino ({picked.length})
        </button>
      </div>
    </div>
  );
}
