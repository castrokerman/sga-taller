import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage, formatDateTime, newOperationKey, photoUrl, type EntityType, type Note, type Photo, type User } from '../api';

/** Fotos y anotaciones de una ubicación, un contenedor o un material. */
export function ItemExtras(props: { user: User; entityType: EntityType; entityId: string; onPhotosChanged?: () => void }) {
  return (
    <>
      <PhotoGallery {...props} />
      <Notes {...props} />
    </>
  );
}

// ---- Fotos ------------------------------------------------------------------

/** Reduce la foto en el propio dispositivo antes de enviarla: menos datos por la wifi y menos espacio. */
async function shrink(file: File): Promise<{ image: string; thumbnail: string; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('No se ha podido leer la foto. Prueba con otra o en formato JPEG'));
      i.src = url;
    });
    const draw = (max: number, quality: number) => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      return { data: canvas.toDataURL('image/jpeg', quality).split(',')[1]!, w, h };
    };
    const big = draw(1600, 0.82);
    const small = draw(400, 0.75);
    return { image: big.data, thumbnail: small.data, width: big.w, height: big.h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function PhotoGallery(props: { user: User; entityType: EntityType; entityId: string; onPhotosChanged?: () => void }) {
  const { user } = props;
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const canAdd = user.permissions.includes('photo.add');

  const load = useCallback(async () => {
    try {
      setPhotos((await api.photos(props.entityType, props.entityId)).photos);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [props.entityType, props.entityId]);

  useEffect(() => {
    setPhotos(null);
    setOpen(null);
    void load();
  }, [load]);

  const changed = async () => {
    await load();
    props.onPhotosChanged?.();
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    const list = [...files];
    try {
      for (const [i, file] of list.entries()) {
        setBusy(list.length > 1 ? `Subiendo ${i + 1} de ${list.length}…` : 'Subiendo foto…');
        const data = await shrink(file);
        await api.addPhoto({ entityType: props.entityType, entityId: props.entityId, ...data }, newOperationKey());
      }
    } catch (e) {
      setError(e instanceof Error && e.constructor === Error ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
      await changed();
    }
  };

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    try {
      await fn();
      after?.();
      await changed();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (photos === null) return null;
  const current = open !== null ? photos[open] : undefined;
  const canRemove = (p: Photo) => p.uploadedById === user.id || user.permissions.includes('photo.manage');

  return (
    <section>
      <div className="section-head">
        <h3>Fotos {photos.length > 0 && <span className="muted small">({photos.length})</span>}</h3>
        {canAdd && (
          <label className="btn btn-small push-right">
            {busy ?? '+ Añadir foto'}
            <input
              ref={input}
              type="file"
              accept="image/*"
              multiple
              hidden
              disabled={Boolean(busy)}
              onChange={(e) => void upload(e.target.files)}
            />
          </label>
        )}
      </div>
      {error && <p className="alert alert-error">{error}</p>}
      {photos.length === 0 ? (
        <p className="muted">Sin fotos.{canAdd && ' Desde el móvil, «Añadir foto» abre la cámara o la galería.'}</p>
      ) : (
        <div className="gallery">
          {photos.map((p, i) => (
            <button key={p.id} className="thumb" onClick={() => setOpen(i)} aria-label={`Ver foto ${i + 1}`}>
              <img src={photoUrl(p.id)} alt="" loading="lazy" />
              {i === 0 && <span className="thumb-main">Principal</span>}
            </button>
          ))}
        </div>
      )}

      {current && (
        <div className="lightbox" role="dialog" aria-modal="true" onClick={() => setOpen(null)}>
          <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <img src={photoUrl(current.id, 'image')} alt="" />
            <div className="lightbox-bar">
              <span className="small">
                {open! + 1} de {photos.length} · {current.uploadedBy}, {formatDateTime(current.uploadedAt)}
              </span>
              <span className="row-actions">
                {photos.length > 1 && (
                  <>
                    <button className="btn btn-small" onClick={() => setOpen((open! - 1 + photos.length) % photos.length)}>‹</button>
                    <button className="btn btn-small" onClick={() => setOpen((open! + 1) % photos.length)}>›</button>
                  </>
                )}
                {canAdd && open! > 0 && (
                  <button className="btn btn-small" onClick={() => act(() => api.makePrimaryPhoto(current.id), () => setOpen(0))}>
                    Hacer principal
                  </button>
                )}
                {canRemove(current) && (
                  <button
                    className="btn btn-small btn-danger"
                    onClick={() => window.confirm('¿Quitar esta foto?') && act(() => api.deletePhoto(current.id), () => setOpen(null))}
                  >
                    Quitar
                  </button>
                )}
                <button className="btn btn-small" onClick={() => setOpen(null)}>
                  Cerrar
                </button>
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---- Anotaciones ------------------------------------------------------------

function Notes(props: { user: User; entityType: EntityType; entityId: string }) {
  const { user } = props;
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [writing, setWriting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canWrite = user.permissions.includes('note.add');

  const load = useCallback(async () => {
    try {
      setNotes((await api.notes(props.entityType, props.entityId)).notes);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [props.entityType, props.entityId]);

  useEffect(() => {
    setNotes(null);
    setWriting(false);
    setNotice(null);
    void load();
  }, [load]);

  if (notes === null) return null;

  return (
    <section>
      <div className="section-head">
        <h3>Anotaciones {notes.length > 0 && <span className="muted small">({notes.length})</span>}</h3>
        {canWrite && !writing && (
          <button className="btn btn-small push-right" onClick={() => { setNotice(null); setWriting(true); }}>
            + Anotación
          </button>
        )}
      </div>
      {notice && <p className="alert alert-ok">{notice}</p>}
      {error && <p className="alert alert-error">{error}</p>}
      {writing && (
        <NoteForm
          {...props}
          onCancel={() => setWriting(false)}
          onDone={async (text) => {
            setWriting(false);
            await load();
            setNotice(text);
          }}
        />
      )}
      {notes.length === 0 ? (
        !writing && <p className="muted">Sin anotaciones.</p>
      ) : (
        <ul className="notes">
          {notes.map((n) => (
            <li key={n.id}>
              <div className="note-head">
                <strong>{n.createdBy}</strong>
                <span className="muted small">{formatDateTime(n.createdAt)}</span>
                {n.notify && <span className="badge badge-warn">Avisados: {n.recipients.join(', ')}</span>}
              </div>
              <p className="note-body">{n.body}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NoteForm(props: { user: User; entityType: EntityType; entityId: string; onCancel: () => void; onDone: (text: string) => void }) {
  const [body, setBody] = useState('');
  const [notify, setNotify] = useState(false);
  const [people, setPeople] = useState<Array<{ id: string; fullName: string; roles: string[] }> | null>(null);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [key] = useState(newOperationKey);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggleNotify = async (on: boolean) => {
    setNotify(on);
    if (on && !people) {
      try {
        const r = await api.noteRecipients(props.entityType, props.entityId);
        setPeople(r.users);
        setSuggested(r.suggested);
        setChosen(new Set(r.suggested));
      } catch (e) {
        setError(errorMessage(e));
      }
    }
  };

  const flip = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.addNote(
        { entityType: props.entityType, entityId: props.entityId, body, notify, recipientIds: notify ? [...chosen] : undefined },
        key,
      );
      props.onDone(r.notified ? `Anotación guardada. Se ha avisado a ${r.note.recipients.join(', ')}` : 'Anotación guardada');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Primero los propuestos; el resto, al pulsar «Avisar a otra persona».
  const list = (people ?? []).filter((p) => showAll || suggested.includes(p.id) || chosen.has(p.id));

  return (
    <form className="card form op-form" onSubmit={submit}>
      <label className="field">
        <span>Anotación</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={4000} required autoFocus />
        <small className="muted">
          Quedará registrada con tu nombre ({props.user.fullName}), la fecha y la hora. No se puede modificar ni borrar después.
        </small>
      </label>
      <label className="check">
        <input type="checkbox" checked={notify} onChange={(e) => void toggleNotify(e.target.checked)} />
        <span>
          <strong>Notificar a responsables</strong>
          <small className="muted"> — les llega un aviso en la campana de la app</small>
        </span>
      </label>
      {notify && people && (
        <div className="recipients">
          {list.length === 0 && <p className="muted small">No hay a quién proponer. Elige a quién avisar.</p>}
          {list.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={chosen.has(p.id)} onChange={() => flip(p.id)} />
              <span>
                {p.fullName}
                <small className="muted">
                  {' '}
                  — {p.roles.join(', ') || 'sin rol'}
                  {suggested.includes(p.id) && ' · propuesto'}
                </small>
              </span>
            </label>
          ))}
          {!showAll && (
            <button type="button" className="linkbtn" onClick={() => setShowAll(true)}>
              + Avisar a otra persona
            </button>
          )}
        </div>
      )}
      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={busy || !body.trim() || (notify && chosen.size === 0)}>
          {busy ? 'Guardando…' : notify ? `Guardar y avisar a ${chosen.size}` : 'Guardar anotación'}
        </button>
      </div>
    </form>
  );
}
