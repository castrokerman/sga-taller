import { useState } from 'react';
import { api, errorMessage, newOperationKey, type User } from '../api';
import { shrink } from './ItemExtras';

/** Aviso para que las galerías de fotos de un contenedor se recarguen. */
export const CONTENTS_PHOTO_EVENT = 'sga:foto-contenido';

/** Sube una foto del contenido de un contenedor (la más reciente es la actual). */
export async function uploadContentsPhoto(containerId: string, file: File) {
  const data = await shrink(file);
  await api.addPhoto({ entityType: 'container', entityId: containerId, purpose: 'CONTENTS', ...data }, newOperationKey());
  window.dispatchEvent(new CustomEvent(CONTENTS_PHOTO_EVENT, { detail: containerId }));
}

/**
 * Tras mover contenido, pregunta por cada contenedor que ha cambiado si se
 * quiere actualizar la foto de lo que lleva dentro. En el móvil abre la cámara.
 */
export function ContentsPhotoPrompt(props: { containers: Array<{ id: string; code: string }>; user: User }) {
  const [state, setState] = useState<Record<string, 'busy' | 'done' | 'skip' | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  if (!props.user.permissions.includes('photo.add')) return null;
  const pending = props.containers.filter((c) => !state[c.id] || state[c.id] === 'busy');
  const done = props.containers.filter((c) => state[c.id] === 'done');
  if (pending.length === 0 && done.length === 0) return null;

  const take = async (id: string, file: File | undefined) => {
    if (!file) return;
    setError(null);
    setState((s) => ({ ...s, [id]: 'busy' }));
    try {
      await uploadContentsPhoto(id, file);
      setState((s) => ({ ...s, [id]: 'done' }));
    } catch (e) {
      setError(e instanceof Error && e.constructor === Error ? e.message : errorMessage(e));
      setState((s) => ({ ...s, [id]: undefined }));
    }
  };

  return (
    <div className="contents-prompt">
      {pending.map((c) => (
        <div key={c.id} className="contents-prompt-row">
          <span>
            📷 Ha cambiado lo que hay en <strong className="mono">{c.code}</strong>. ¿Quieres actualizar la foto de los contenidos en el interior?
          </span>
          <span className="row-actions">
            <label className={`btn btn-small btn-primary ${state[c.id] === 'busy' ? 'disabled' : ''}`}>
              {state[c.id] === 'busy' ? 'Subiendo…' : 'Hacer foto'}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                disabled={state[c.id] === 'busy'}
                onChange={(e) => void take(c.id, e.target.files?.[0])}
              />
            </label>
            <button type="button" className="btn btn-small" disabled={state[c.id] === 'busy'} onClick={() => setState((s) => ({ ...s, [c.id]: 'skip' }))}>
              Ahora no
            </button>
          </span>
        </div>
      ))}
      {done.map((c) => (
        <p key={c.id} className="nomargin small">
          ✓ Foto del contenido de <strong className="mono">{c.code}</strong> actualizada.
        </p>
      ))}
      {error && <p className="alert alert-error nomargin">{error}</p>}
    </div>
  );
}
