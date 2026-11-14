import { useEffect, useState } from 'react';
import { api, errorMessage, formatDate, formatQty, newOperationKey, type Loan, type OpResult, type PlaceRef, type User } from '../api';
import { OpNotice, PlacePicker } from '../components/Stock';

/** Herramientas prestadas: quién las tiene y hasta cuándo. */
export function LoansPage({ user }: { user: User }) {
  const [loans, setLoans] = useState<Loan[] | null>(null);
  const [all, setAll] = useState(false);
  const [returning, setReturning] = useState<Loan | null>(null);
  const [notice, setNotice] = useState<OpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manage = user.permissions.includes('loan.manage');

  const load = async (withClosed = all) => {
    try {
      setLoans((await api.loans(withClosed)).loans);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const giveBack = async (loan: Loan, place?: PlaceRef) => {
    setError(null);
    try {
      const r = await api.returnLoan(loan.id, place ?? {}, newOperationKey());
      setReturning(null);
      await load();
      setNotice(r);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const open = (loans ?? []).filter((l) => l.status === 'OPEN');
  const overdue = open.filter((l) => l.overdue).length;

  return (
    <>
      <nav className="crumbs">
        <a href="#/inicio">Inicio</a>
        <span>
          <i>›</i>
          <strong>Préstamos</strong>
        </span>
      </nav>
      <div className="page-head">
        <div>
          <h2>Préstamos de herramientas</h2>
          <p className="muted nomargin">
            {open.length} prestado{open.length === 1 ? '' : 's'}
            {overdue > 0 && <span className="over"> · {overdue} fuera de plazo</span>}. Para prestar algo, ve a su sitio o a su ficha y pulsa «Prestar».
          </p>
        </div>
      </div>
      {notice && <OpNotice r={notice} />}
      {error && <p className="alert alert-error">{error}</p>}
      {returning && (
        <div className="card form op-form">
          <h3>Devolver {returning.description} a otro sitio</h3>
          <PlacePicker hint="Escanea dónde lo dejas." onPick={(p) => giveBack(returning, p.ref)} onCancel={() => setReturning(null)} />
        </div>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => {
            setAll(e.target.checked);
            void load(e.target.checked);
          }}
        />
        <span>Ver también los ya devueltos</span>
      </label>
      {loans === null ? (
        <p className="muted">Cargando…</p>
      ) : loans.length === 0 ? (
        <p className="muted">No hay nada prestado.</p>
      ) : (
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th>Herramienta</th>
                <th>Quién</th>
                <th>Devolver el</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loans.map((l) => (
                <tr key={l.id} className={l.status !== 'OPEN' ? 'row-off' : undefined}>
                  <td>
                    <a href={`#/material/${l.materialId}`}>
                      <strong>{l.description}</strong>
                    </a>
                    <div className="muted small">
                      {formatQty(l.quantity, l.unitCode)} · salió de {l.fromCode ?? '—'} el {formatDate(l.loanedAt)}
                    </div>
                  </td>
                  <td>{l.borrowerName}</td>
                  <td className={`nowrap ${l.overdue ? 'over' : ''}`}>
                    {l.status === 'OPEN' ? (
                      <>
                        {formatDate(l.dueAt)}
                        {l.overdue && <div className="small">Fuera de plazo</div>}
                      </>
                    ) : (
                      <span className="muted">Devuelto el {formatDate(l.returnedAt)}</span>
                    )}
                  </td>
                  <td>
                    {l.status === 'OPEN' && (manage || l.borrowerId === user.id) && (
                      <span className="line-actions">
                        <button className="btn btn-small btn-primary" onClick={() => giveBack(l)}>
                          Devolver a {l.fromCode ?? 'su sitio'}
                        </button>
                        <button className="btn btn-small" onClick={() => { setNotice(null); setReturning(l); }}>
                          A otro sitio
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
