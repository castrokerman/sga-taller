import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';

export function ChangePasswordPage(props: { forced?: boolean; onDone: () => void; onCancel?: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) {
      setError('Las dos contraseñas nuevas no coinciden');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      props.onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ha ocurrido un error inesperado');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card narrow" onSubmit={submit}>
      <h2>{props.forced ? 'Elige tu contraseña' : 'Cambiar contraseña'}</h2>
      {props.forced && (
        <p className="alert alert-info">
          Tu contraseña actual es provisional. Elige una nueva para empezar a usar el sistema.
        </p>
      )}

      <label className="field">
        <span>Contraseña actual</span>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required autoFocus />
      </label>
      <label className="field">
        <span>Contraseña nueva</span>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} required />
        <small className="muted">Mínimo 10 caracteres.</small>
      </label>
      <label className="field">
        <span>Repite la contraseña nueva</span>
        <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" minLength={10} required />
      </label>

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      <div className="actions">
        {props.onCancel && (
          <button type="button" className="btn" onClick={props.onCancel}>
            Cancelar
          </button>
        )}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar contraseña'}
        </button>
      </div>
    </form>
  );
}
