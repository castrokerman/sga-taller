import { useRef } from 'react';
import { api, errorMessage, newOperationKey } from '../api';
import { shrink } from './ItemExtras';

/** Botón para hacer (o elegir) la foto del albarán o del pedido. En el móvil abre la cámara. */
export function DocPhotoField(props: { file: File | null; onChange: (f: File | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <span className="doc-photo">
      <label className="btn btn-small">
        {props.file ? '🧾 Foto lista' : '📷 Foto del albarán'}
        <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(e) => props.onChange(e.target.files?.[0] ?? null)} />
      </label>
      {props.file && (
        <button type="button" className="linkbtn small" onClick={() => { props.onChange(null); if (input.current) input.current.value = ''; }}>
          Quitar
        </button>
      )}
    </span>
  );
}

/**
 * Une la foto del albarán al movimiento de la entrada. Si falla, la entrada ya
 * está hecha: devuelve un aviso para añadirlo al mensaje.
 */
export async function attachDocPhoto(movementId: string | undefined, file: File | null): Promise<string> {
  if (!file || !movementId) return '';
  try {
    await api.addPhoto({ entityType: 'movement', entityId: movementId, ...(await shrink(file)) }, newOperationKey());
    return '. Foto del albarán guardada';
  } catch (e) {
    return `. La foto del albarán no se ha podido guardar (${errorMessage(e)})`;
  }
}
