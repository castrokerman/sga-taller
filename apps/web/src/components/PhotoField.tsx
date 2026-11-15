import { useEffect, useRef, useState } from 'react';
import { api, newOperationKey } from '../api';
import { shrink } from './ItemExtras';

/** Foto opcional en un formulario de alta: abre la cámara en el móvil y enseña cómo queda. */
export function PhotoField(props: { label?: string; hint?: string; file: File | null; onChange: (f: File | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!props.file) return setUrl(null);
    const u = URL.createObjectURL(props.file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [props.file]);
  return (
    <div className="field">
      <span className="field-l">
        {props.label ?? 'Foto'} <span className="muted">(opcional)</span>
      </span>
      <div className="shots">
        {url && (
          <figure className="shot">
            <img src={url} alt="Foto elegida" />
            <button
              type="button"
              className="shot-x"
              aria-label="Quitar la foto"
              onClick={() => {
                props.onChange(null);
                if (input.current) input.current.value = '';
              }}
            >
              ×
            </button>
          </figure>
        )}
        {!url && (
          <label className="shot shot-add">
            <span aria-hidden="true">📷</span>
            <span>Hacer foto</span>
            <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(e) => props.onChange(e.target.files?.[0] ?? null)} />
          </label>
        )}
      </div>
      {props.hint && <small className="muted">{props.hint}</small>}
    </div>
  );
}

/** Sube la foto a la ficha del material. Devuelve el id de la foto o el motivo del fallo. */
export async function uploadMaterialPhoto(materialId: string, file: File): Promise<{ id?: string; error?: string }> {
  try {
    const r = await api.addPhoto({ entityType: 'material', entityId: materialId, ...(await shrink(file)) }, newOperationKey());
    return { id: r.photo.id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
