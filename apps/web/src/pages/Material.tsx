import { useCallback, useEffect, useState } from 'react';
import {
  type UnitRef,
  api, errorMessage, formatDate, formatDateTime, formatQty, MOVEMENT_NAMES, TRACKING_NAMES,
  type MaterialDetail, type MovementLine, type OpResult, type User,
} from '../api';
import { can, LineActions, OpNotice, OpPanel, StockKind, UnitLabels } from '../components/Stock';
import { LabelPanel } from '../components/Common';
import { ItemExtras } from '../components/ItemExtras';
import { Thumb } from '../components/Thumb';
import { MaterialForm } from './Materials';
import { navigate } from '../router';
import { ReverseButton } from './Movements';
import { LoanChip, singleLoanable } from './Materials';
import { DeleteButton } from '../components/DeleteButton';

type Op = Parameters<typeof OpPanel>[0]['op'];

/** Ficha de un material: dónde está, cuánto hay y todos sus movimientos. */
export function MaterialPage({ user, materialId }: { user: User; materialId: string }) {
  const [d, setD] = useState<MaterialDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'edit' | 'duplicate' | 'labels'>('none');
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitResult, setSplitResult] = useState<UnitRef[] | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  const [notice, setNotice] = useState<OpResult | string | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await api.material(materialId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [materialId]);

  useEffect(() => {
    setD(null);
    setPanel('none');
    setOp(null);
    setNotice(null);
    void load();
  }, [load]);

  const start = (next: Op) => {
    setNotice(null);
    setPanel('none');
    setOp(next);
  };

  const done = async (r: OpResult | string) => {
    setOp(null);
    setPanel('none');
    await load();
    setNotice(r);
  };

  if (!d) return error ? <p className="alert alert-error">{error}</p> : <p className="muted">Cargando…</p>;
  const m = d.material;
  const restricted = d.stock.reduce((s, l) => s + (l.quantityRestricted ?? 0), 0);
  const assigned = d.stock.reduce((s, l) => s + (l.quantityRestricted ?? 0) + (l.quantityProjectFree ?? 0), 0);
  const tracked = m.quantityTracking !== 'NOT_TRACKED';
  const details = [m.manufacturer, m.manufacturerRef && `ref. ${m.manufacturerRef}`, m.materialSpec, m.qualityGrade, m.dimensions].filter(Boolean);

  return (
    <>
      <nav className="crumbs">
        <a href="#/contenidos">Contenidos</a>
        {d.familyPath.split(' › ').map((f) => (
          <span key={f}>
            <i>›</i>
            {f}
          </span>
        ))}
        <span>
          <i>›</i>
          <strong>{m.internalRef}</strong>
        </span>
      </nav>

      {m.deletedAt && (
        <p className="alert alert-warn">
          Este contenido está eliminado ({formatDateTime(m.deletedAt)}). Ya no sale en listas, buscador ni escáner; se conserva para su historial.
        </p>
      )}
      <div className="page-head">
        {m.photoId && (
          <span className="head-thumb">
            <Thumb photoId={m.photoId} />
          </span>
        )}
        <div>
          <h2>
            {m.description} {singleLoanable(m) && <LoanChip m={m} />}
          </h2>
          <p className="muted nomargin">
            <span className="tag tag-type">{m.contentTypeName}</span> {m.internalRef} · {m.familyName}
            {m.unitTracked
              ? <> · una unidad con su propio código{m.serialNumber && <> · nº de serie <strong>{m.serialNumber}</strong></>}</>
              : <> · se cuenta en {m.unitCode}, {TRACKING_NAMES[m.quantityTracking].toLowerCase()}</>}
            {m.minStock !== null && tracked && ` · aviso si baja de ${formatQty(m.minStock, m.unitCode)}`}
            {m.lotTracked && ' · con lote'}
          </p>
          {details.length > 0 && <p className="nomargin">{details.join(' · ')}</p>}
          {m.notes && <p className="nomargin muted">{m.notes}</p>}
        </div>
        <div className="push-right row-actions">
          {m.status === 'OBSOLETE' && <span className="badge badge-off">De baja</span>}
          {m.isLoanable && <span className="badge badge-ok">Prestable</span>}
        </div>
      </div>

      <div className="toolbar">
        {can(user, 'stock.receive') && m.status === 'ACTIVE' && (
          <button className="btn btn-primary" onClick={() => start({ kind: 'receipt', material: m })}>
            + Entrada
          </button>
        )}
        {m.unitTracked && can(user, 'label.print') && (
          <button className="btn" onClick={() => { setOp(null); setNotice(null); setPanel('labels'); }}>
            Etiqueta QR
          </button>
        )}
        {can(user, 'material.manage') && (
          <button className="btn" onClick={() => { setOp(null); setNotice(null); setPanel('edit'); }}>
            Editar
          </button>
        )}
        {can(user, 'material.manage') && (
          <button className="btn" onClick={() => { setOp(null); setNotice(null); setPanel('duplicate'); }}>
            Duplicar
          </button>
        )}
      </div>

      {notice && (typeof notice === 'string' ? <p className="alert alert-ok">{notice}</p> : <OpNotice r={notice} user={user} />)}
      {panel === 'edit' && (
        <MaterialForm
          title={`Editar ${m.internalRef}`}
          initial={m}
          materialId={m.id}
          onCancel={() => setPanel('none')}
          onDone={() => done('Cambios guardados')}
          extra={can(user, 'material.delete') && (
            <DeleteButton
              what={`${m.internalRef} · ${m.description}`}
              warning="Lo que quede guardado se saca de su sitio (queda como retirada en el historial). Si tiene historial se conserva, pero desaparece de listas, buscador y escáner."
              run={async () => {
                const r = await api.deleteMaterial(m.id);
                return r.keptHistory ? `${r.ref} eliminado; su historial se conserva` : `${r.ref} eliminado del todo`;
              }}
              onDone={(msg) => { window.sessionStorage.setItem('sga.aviso', msg); navigate('contenidos'); }}
            />
          )}
        />
      )}
      {panel === 'labels' && (
        <LabelPanel groups={[{ label: m.internalRef, items: [{ kind: 'material', id: m.id }] }]} onClose={() => setPanel('none')} />
      )}
      {m.unitTracked && (m.quantity ?? 0) + m.onLoan > 1 && (
        <div className="alert alert-warn">
          <p className="nomargin">
            Hay <strong>{(m.quantity ?? 0) + m.onLoan} unidades</strong> con el mismo código {m.internalRef}. Como {m.contentTypeName.toLowerCase()} se
            lleva por unidad, cada una debe tener su propio código.
          </p>
          {can(user, 'material.manage') && (
            <button
              className="btn btn-primary"
              style={{ marginTop: '0.5rem' }}
              disabled={splitBusy}
              onClick={async () => {
                setSplitBusy(true);
                try {
                  const r = await api.splitUnits(m.id);
                  await load();
                  setSplitResult(r.units);
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setSplitBusy(false);
                }
              }}
            >
              {splitBusy ? 'Separando…' : 'Separar en unidades'}
            </button>
          )}
        </div>
      )}
      {splitResult && (
        <div className="alert alert-ok">
          <p className="nomargin">
            Separadas: {m.internalRef} se queda con una y las demás tienen ahora su propio código: {splitResult.map((u) => u.internalRef).join(', ')}.
          </p>
          <UnitLabels units={[{ id: m.id, internalRef: m.internalRef }, ...splitResult]} />
        </div>
      )}
      {panel === 'duplicate' && (
        <MaterialForm
          title={`Nuevo contenido a partir de ${m.internalRef}`}
          canPhoto={user.permissions.includes('photo.add')}
          initial={{ ...m, internalRef: undefined, status: undefined, description: m.description }}
          onCancel={() => setPanel('none')}
          onDone={(n) => navigate(`contenido/${n.id}`)}
        />
      )}
      {op && <OpPanel op={op} user={user} lines={[]} onCancel={() => setOp(null)} onDone={done} />}

      {tracked ? (
        <div className="kpis">
          <div className={`kpi ${m.lowStock ? 'kpi-low' : ''}`}>
            <b>{formatQty(m.quantity ?? 0, m.unitCode, m.quantityTracking)}</b>
            <span>{m.lowStock ? 'En total · stock bajo' : 'En total'}</span>
          </div>
          {assigned > 0 && (
            <div className="kpi">
              <b>{formatQty((m.quantity ?? 0) - restricted, m.unitCode)}</b>
              <span>Se puede retirar sin autorización</span>
            </div>
          )}
          {restricted > 0 && (
            <div className="kpi">
              <b>{formatQty(restricted, m.unitCode)}</b>
              <span>Restringido a proyectos</span>
            </div>
          )}
          {m.onLoan > 0 && (
            <div className="kpi">
              <b>{formatQty(m.onLoan, m.unitCode)}</b>
              <span>Prestado ahora</span>
            </div>
          )}
        </div>
      ) : (
        <p className="muted">Este contenido no se cuenta: se ve en qué sitios hay y quién se lleva.</p>
      )}

      <div className="two">
        <section>
          <h3>Dónde está</h3>
          {d.stock.length === 0 ? (
            <p className="muted">No hay en ningún sitio.</p>
          ) : (
            <div className="table-wrap card">
              <table className="stock-table">
                <thead>
                  <tr>
                    <th>Sitio</th>
                    <th>Tipo de stock</th>
                    <th className="num">Cantidad</th>
                  </tr>
                </thead>
                <tbody>
                  {d.stock.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <a className="mono" href={l.containerId ? `#/contenedor/${l.containerId}` : `#/almacen/${l.locationId}`}>
                          {l.placeCode}
                        </a>
                        {l.containerId && l.locationCode && <div className="muted small mono">{l.locationCode}</div>}
                        {l.lotCode && <div className="muted small">Lote {l.lotCode}</div>}
                        <LineActions user={user} line={l} onOp={start} />
                      </td>
                      <td>
                        <StockKind line={l} />
                      </td>
                      <td className="num nowrap">
                        <strong>{formatQty(l.quantity, l.unitCode, l.quantityTracking)}</strong>
                        {l.needsRecount && <div><span className="badge badge-warn">Recontar</span></div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {d.loans.length > 0 && (
            <>
              <h3 style={{ marginTop: '1.5rem' }}>Prestado ahora</h3>
              <ul className="plain">
                {d.loans.map((l) => (
                  <li key={l.id} className={l.overdue ? 'over' : undefined}>
                    <strong>{l.borrowerName}</strong> · {formatQty(l.quantity, l.unitCode)} · devolver el {formatDate(l.dueAt)}
                    {l.overdue && ' · fuera de plazo'}
                  </li>
                ))}
              </ul>
              <a href="#/prestamos">Ver todos los préstamos</a>
            </>
          )}
        </section>

        <section>
          <h3>Huella: todos los movimientos</h3>
          {d.movements.length === 0 ? <p className="muted">Sin movimientos todavía.</p> : <History user={user} lines={d.movements} onReversed={done} />}
          <p className="muted small">Nada se borra: un error se corrige con un movimiento nuevo, que también queda registrado.</p>
        </section>
      </div>

      <div className="two">
        <div>
          <ItemExtras user={user} entityType="material" entityId={m.id} />
        </div>
      </div>
    </>
  );
}

const ICONS: Record<string, [string, string]> = {
  RECEIPT: ['+', 'in'], RETURN: ['+', 'in'], LOAN_RETURN: ['↩', 'in'],
  WITHDRAWAL: ['−', 'out'], LOAN_OUT: ['↗', 'out'],
  TRANSFER: ['→', 'mv'], COUNT: ['=', 'cnt'], ADJUSTMENT: ['=', 'cnt'], REVERSAL: ['↶', 'cnt'],
};

export function History({ user, lines, showMaterial, onReversed }: { user: User; lines: MovementLine[]; showMaterial?: boolean; onReversed: (r: OpResult) => void }) {
  return (
    <ul className="hist">
      {lines.map((l) => {
        const [icon, cls] = ICONS[l.movementType] ?? ['·', 'cnt'];
        return (
          <li key={`${l.movementId}-${l.lineNo}`}>
            <span className={`ic ${cls}`}>{icon}</span>
            <span>
              <b>
                {MOVEMENT_NAMES[l.movementType] ?? l.movementType}
                {l.reversesNumber && ` del n.º ${l.reversesNumber}`} ·{' '}
                {l.containerId ? <a href={`#/contenedor/${l.containerId}`}>{l.placeCode}</a> : <a href={`#/almacen/${l.locationId}`}>{l.placeCode}</a>}
              </b>
              {showMaterial && (
                <div>
                  <a href={`#/contenido/${l.materialId}`}>{l.description}</a>
                </div>
              )}
              <small>
                {l.performedBy} · {formatDateTime(l.performedAt)} · n.º {l.movementNumber}
                {l.reason && ` · «${l.reason}»`}
                {l.externalReference && ` · ${l.externalReference}`}
                {l.documentPhotoId && (
                  <span className="doc-in-history" title="Foto del albarán">
                    {' · 🧾 '}
                    <Thumb photoId={l.documentPhotoId} className="doc-thumb" alt="Albarán" />
                  </span>
                )}
                {l.lotCode && ` · lote ${l.lotCode}`}
                {l.reversedByNumber && <span className="badge badge-off"> Revertido con el n.º {l.reversedByNumber}</span>}
              </small>
              {l.lineNo === 1 && <ReverseButton user={user} line={l} onDone={onReversed} />}
            </span>
            <span className="q">
              {l.quantityTracking === 'NOT_TRACKED'
                ? ''
                : `${(l.quantityDelta ?? 0) > 0 ? '+' : ''}${(l.quantityDelta ?? 0).toLocaleString('es-ES', { maximumFractionDigits: 4 })}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
