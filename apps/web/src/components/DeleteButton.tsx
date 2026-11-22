import { useState } from 'react';
import { errorMessage } from '../api';

/**
 * «🗑 Eliminar» dentro de «Editar» de una ficha: pide confirmación, elimina y
 * avisa. Si no se puede, explica por qué.
 */
export function DeleteButton(props: { what: string; warning: string; run: () => Promise<string>; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn-delete-ghost"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm(`¿Seguro que quieres eliminar ${props.what}?\n\n${props.warning}\nNo se puede deshacer.`)) return;
          setBusy(true);
          setError(null);
          try {
            props.onDone(await props.run());
          } catch (e) {
            setError(errorMessage(e));
            setBusy(false);
          }
        }}
      >
        {busy ? 'Eliminando…' : '🗑 Eliminar'}
      </button>
      {error && <p className="alert alert-error delete-error">{error}</p>}
    </>
  );
}
