import { useMemo, useState } from 'react';
import { errorMessage } from '../api';

/**
 * Edición de varias filas a la vez, como en una hoja de cálculo.
 * Las celdas cambiadas se marcan; «Guardar» envía todos los cambios juntos
 * y, si una fila falla, no se guarda ninguna.
 */

export type CellValue = string | boolean;

export interface BulkColumn<T> {
  key: string;
  label: string;
  /** static: solo se muestra; segment: parte final de un código con prefijo fijo. */
  type: 'text' | 'number' | 'select' | 'check' | 'segment' | 'static';
  get: (row: T) => CellValue;
  options?: Array<{ value: string; label: string }>;
  prefix?: (row: T) => string | null;
  /** Sangría (niveles) para ver la jerarquía, como en el árbol. */
  indent?: (row: T) => number;
  width?: string;
  placeholder?: string;
  required?: boolean;
  /** Se puede poner el mismo valor en todas las filas de una vez. */
  fillAll?: boolean;
  decimals?: boolean;
}

export type BulkChanges = Array<{ id: string; values: Record<string, CellValue> }>;

export function BulkEditor<T extends { id: string }>(props: {
  title: string;
  hint?: string;
  rows: T[];
  columns: Array<BulkColumn<T>>;
  onSave: (changes: BulkChanges) => Promise<string>;
  onClose: (message?: string) => void;
}) {
  const { rows, columns } = props;
  const [edits, setEdits] = useState<Record<string, Record<string, CellValue>>>({});
  const startValue = (c?: BulkColumn<T>): CellValue =>
    c?.type === 'check' ? true : c?.type === 'select' && c.required ? c.options?.[0]?.value ?? '' : '';
  const [fillKey, setFillKey] = useState(columns.find((c) => c.fillAll)?.key ?? '');
  const [fillValue, setFillValue] = useState<CellValue>(() => startValue(columns.find((c) => c.fillAll)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const value = (row: T, col: BulkColumn<T>) => edits[row.id]?.[col.key] ?? col.get(row);
  const changed = (row: T, col: BulkColumn<T>) => col.key in (edits[row.id] ?? {}) && edits[row.id]![col.key] !== col.get(row);

  const set = (row: T, col: BulkColumn<T>, v: CellValue) => {
    setEdits((all) => {
      const mine = { ...(all[row.id] ?? {}) };
      if (v === col.get(row)) delete mine[col.key];
      else mine[col.key] = v;
      const next = { ...all };
      if (Object.keys(mine).length) next[row.id] = mine;
      else delete next[row.id];
      return next;
    });
  };

  const changes: BulkChanges = useMemo(
    () => Object.entries(edits).map(([id, values]) => ({ id, values })).filter((c) => Object.keys(c.values).length > 0),
    [edits],
  );
  const cells = changes.reduce((n, c) => n + Object.keys(c.values).length, 0);
  const fillCol = columns.find((c) => c.key === fillKey);

  const fill = () => {
    if (!fillCol) return;
    for (const row of rows) set(row, fillCol, fillValue);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const message = await props.onSave(changes);
      props.onClose(message);
    } catch (e) {
      // Los errores de comprobación propios (no de la API) traen ya un mensaje para el usuario.
      setError(e instanceof Error && e.constructor === Error ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const fillable = columns.filter((c) => c.fillAll);

  return (
    <div className="card form bulk">
      <div className="bulk-head">
        <div>
          <h3>{props.title}</h3>
          <p className="muted small nomargin">
            {props.hint ?? 'Cambia lo que necesites en la tabla. Lo cambiado se marca en amarillo y se guarda todo junto.'}
          </p>
        </div>
      </div>

      {fillable.length > 0 && (
        <div className="bulk-fill">
          <span>Poner en las {rows.length} filas:</span>
          <select value={fillKey} onChange={(e) => { setFillKey(e.target.value); setFillValue(startValue(columns.find((c) => c.key === e.target.value))); }}>
            {fillable.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          {fillCol && <Editor col={fillCol} value={fillValue} onChange={setFillValue} />}
          <button type="button" className="btn btn-small" onClick={fill}>
            Aplicar a todas
          </button>
        </div>
      )}

      <div className="bulk-table">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} style={{ minWidth: c.width }}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={edits[row.id] ? 'row-changed' : undefined}>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={changed(row, c) ? 'changed' : undefined}
                    style={c.indent ? { paddingLeft: `${0.35 + c.indent(row) * 1.1}rem` } : undefined}
                  >
                    {c.type === 'static' ? (
                      <span className="mono">{String(c.get(row))}</span>
                    ) : (
                      <Editor col={c} prefix={c.prefix?.(row) ?? null} value={value(row, c)} onChange={(v) => set(row, c, v)} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        {cells > 0 && (
          <button type="button" className="btn" onClick={() => setEdits({})} disabled={busy}>
            Deshacer cambios
          </button>
        )}
        <button type="button" className="btn" onClick={() => props.onClose()} disabled={busy}>
          {cells > 0 ? 'Cancelar' : 'Cerrar'}
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || cells === 0}>
          {busy ? 'Guardando…' : cells === 0 ? 'Sin cambios' : `Guardar ${cells} cambio${cells > 1 ? 's' : ''} en ${changes.length} fila${changes.length > 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  );
}

function Editor<T>(props: { col: BulkColumn<T>; prefix?: string | null; value: CellValue; onChange: (v: CellValue) => void }) {
  const { col } = props;
  if (col.type === 'check') {
    return <input type="checkbox" className="bulk-check" checked={Boolean(props.value)} onChange={(e) => props.onChange(e.target.checked)} aria-label={col.label} />;
  }
  if (col.type === 'select') {
    return (
      <select value={String(props.value)} onChange={(e) => props.onChange(e.target.value)} aria-label={col.label}>
        {!col.required && <option value="">—</option>}
        {col.options!.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (col.type === 'segment') {
    return (
      <span className="code-input">
        {props.prefix && <span className="code-prefix">{props.prefix}-</span>}
        <input
          value={String(props.value)}
          onChange={(e) => props.onChange(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
          spellCheck={false}
          aria-label={col.label}
        />
      </span>
    );
  }
  return (
    <input
      value={String(props.value)}
      onChange={(e) =>
        props.onChange(col.type === 'number' ? e.target.value.replace(col.decimals ? /[^\d,.]/g : /\D/g, '') : e.target.value)
      }
      inputMode={col.type === 'number' ? 'decimal' : undefined}
      placeholder={col.placeholder}
      aria-label={col.label}
    />
  );
}

/** Campo de código con el prefijo de la ubicación superior fijo, sin poder editarlo. */
export function CodeInput(props: {
  prefix: string | null;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <span className="code-input code-input-big">
      {props.prefix && <span className="code-prefix" title="Lo pone la ubicación que la contiene">{props.prefix}-</span>}
      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
        required
        autoFocus={props.autoFocus}
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={40}
      />
    </span>
  );
}
