import { useEffect, useState } from 'react';
import { api, errorMessage, MOVEMENT_NAMES, newOperationKey, type MovementLine, type OpResult, type User } from '../api';
import { optionsFrom, useListControls } from '../components/ListControls';
import { OpNotice } from '../components/Stock';
import { History } from './Material';

const REVERSIBLE = new Set(['RECEIPT', 'WITHDRAWAL', 'RETURN', 'TRANSFER', 'COUNT']);

/** Últimos movimientos de material de todo el almacén. */
export function MovementsPage({ user }: { user: User }) {
  const [lines, setLines] = useState<MovementLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<OpResult | null>(null);

  const load = async () => {
    try {
      setLines((await api.movements(1000)).movements);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const items = lines ?? [];
  const list = useListControls(items, {
    storageKey: 'movimientos',
    noun: 'líneas',
    placeholder: 'Buscar material, sitio, persona o motivo…',
    text: (l) => [l.description, l.internalRef, l.placeCode, l.performedBy, l.reason, l.externalReference, l.lotCode, String(l.movementNumber)],
    sorts: [
      { key: 'fecha', label: 'Fecha', value: (l) => l.movementNumber * 1000 + l.lineNo, defaultDir: 'desc' },
      { key: 'material', label: 'Material', value: (l) => l.description },
      { key: 'persona', label: 'Persona', value: (l) => l.performedBy },
    ],
    filters: [
      {
        key: 'tipo', label: 'Tipo',
        options: optionsFrom(items, (l) => MOVEMENT_NAMES[l.movementType] ?? l.movementType),
        test: (l, v) => (MOVEMENT_NAMES[l.movementType] ?? l.movementType) === v,
      },
      { key: 'persona', label: 'Persona', options: optionsFrom(items, (l) => l.performedBy), test: (l, v) => l.performedBy === v },
    ],
  });

  return (
    <>
      <nav className="crumbs">
        <a href="#/inicio">Inicio</a>
        <span>
          <i>›</i>
          <strong>Movimientos</strong>
        </span>
      </nav>
      <div className="page-head">
        <div>
          <h2>Movimientos</h2>
          <p className="muted nomargin">Entradas, retiradas, traslados, recuentos y préstamos de material. Los más recientes primero.</p>
        </div>
        <a className="btn push-right" href="/api/export/stock.xlsx" download>
          Stock a Excel
        </a>
      </div>
      {notice && <OpNotice r={notice} />}
      {error && <p className="alert alert-error">{error}</p>}
      {lines === null ? (
        <p className="muted">Cargando…</p>
      ) : lines.length === 0 ? (
        <p className="muted">Todavía no hay movimientos de material.</p>
      ) : (
        <>
          {list.bar}
          <div className="card">
            <History
              user={user}
              lines={list.visible}
              showMaterial
              onReversed={async (r) => {
                await load();
                setNotice(r);
              }}
            />
          </div>
        </>
      )}
    </>
  );
}

/** Botón para revertir un movimiento: pide el motivo y crea el movimiento contrario. */
export function ReverseButton({ user, line, onDone }: { user: User; line: MovementLine; onDone: (r: OpResult) => void }) {
  const [error, setError] = useState<string | null>(null);
  if (!user.permissions.includes('stock.reverse') || !REVERSIBLE.has(line.movementType) || line.reversedByNumber || line.quantityTracking === 'NOT_TRACKED') {
    return null;
  }
  const reverse = async () => {
    const reason = window.prompt(`¿Por qué se revierte el movimiento n.º ${line.movementNumber}?`, 'Registrado por error');
    if (!reason || reason.trim().length < 3) return;
    setError(null);
    try {
      onDone(await api.reverse(line.movementId, reason.trim(), newOperationKey()));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <>
      <button className="linkbtn small" onClick={reverse}>
        Revertir
      </button>
      {error && <span className="alert alert-error small" style={{ display: 'block' }}>{error}</span>}
    </>
  );
}
