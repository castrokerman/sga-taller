import { useState } from 'react';
import { api, errorMessage } from '../api';
import { Scanner } from '../components/Scanner';
import { navigate } from '../router';

/** Escanear un QR y abrir la ficha de lo que sea: una ubicación o un contenedor. */
export function ScannerPage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onCode = async (code: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const hit = await api.scan(code);
      if (hit.kind === 'location') navigate(`almacen/${hit.id}`);
      else if (hit.kind === 'container') navigate(`contenedor/${hit.id}`);
      else setError(`${hit.code} es un equipo. Las fichas de equipos llegan en la Fase 5`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <a className="btn" href="#/inicio">
          ← Inicio
        </a>
        <h2>Escáner</h2>
      </div>
      <div className="narrow-wide">
        <Scanner onCode={onCode} busy={busy} hint="Apunta al QR de una ubicación o de un contenedor." />
        {error && <p className="alert alert-error">{error}</p>}
      </div>
    </>
  );
}
