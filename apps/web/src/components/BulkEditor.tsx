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
  /**
   * Eliminar: un botón «Eliminar…» que deja marcar filas y eliminarlas de una
   * vez, siempre con confirmación. run devuelve el mensaje de cada una.
   */
  remove?: {
    /** Cómo se llama una fila, para el aviso: «MAT-000012 · Tornillo M6». */
    name: (row: T) => string;
    /** Lo que se advierte antes de confirmar. */
    warning: string;
    run: (row: T) => Promise<string>;
    /** Tras eliminar alguna: recargar la lista. */
    onRemoved?: () => Promise<void> | void;
  };
}) {
  const { rows, columns } = props;
  const [edits, setEdits] = useState<Record<string, Record<string, CellValue>>>({});
  const startValue = (c?: BulkColumn<T>): CellValue =>
    c?.type === 'check' ? true : c?.type === 'select' && c.required ? c.options?.[0]?.value ?? '' : '';
  const [fillKey, setFillKey] = useState(columns.find((c) => c.fillAll)?.key ?? '');
  const [fillValue, setFillValue] = useState<CellValue>(() => startValue(columns.find((c) => c.fillAll)));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  const removePicked = async () => {
    const r = props.remove!;
    const chosen = rows.filter((x) => picked.includes(x.id));
    if (!chosen.length) return;
    const names = chosen.slice(0, 12).map((x) => `• ${r.name(x)}`).join('\n') + (chosen.length > 12 ? `\n… y ${chosen.length - 12} más` : '');
    if (!window.confirm(`¿Seguro que quieres eliminar ${chosen.length === 1 ? 'esto' : `estos ${chosen.length}`}?\n\n${names}\n\n${r.warning}\nNo se puede deshacer.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const ok: string[] = [];
    const bad: string[] = [];
    for (const x of chosen) {
      try {
        ok.push(await r.run(x));
      } catch (e) {
        bad.push(`${r.name(x)}: ${errorMessage(e)}`);
      }
    }
    setBusy(false);
    setPicked([]);
    if (ok.length) {
      setNotice(ok.length === 1 ? ok[0]! : `Eliminados ${ok.length}:\n${ok.join('\n')}`);
      setEdits({});
      await r.onRemoved?.();
    }
    if (bad.length) setError(`No se ${bad.length === 1 ? 'ha' : 'han'} podido eliminar:\n${bad.join('\n')}`);
    else setPicking(false);
  };

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

      {props.remove && (
        <div className="bulk-remove">
          {!picking ? (
            <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={() => { setPicking(true); setPicked([]); setNotice(null); setError(null); }}>
              Eliminar…
            </button>
          ) : (
            <>
              <span>Marca lo que quieres eliminar:</span>
              <button type="button" className="btn btn-small btn-danger" disabled={busy || picked.length === 0} onClick={() => void removePicked()}>
                {busy ? 'Eliminando…' : `Eliminar ${picked.length || ''} seleccionado${picked.length === 1 ? '' : 's'}`}
              </button>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => { setPicking(false); setPicked([]); }}>
                Cancelar
              </button>
            </>
          )}
        </div>
      )}

      <div className="bulk-table">
        <table>
          <thead>
            <tr>
              {picking && (
                <th className="bulk-pick">
                  <input
                    type="checkbox"
                    aria-label="Marcar todas"
                    checked={rows.length > 0 && picked.length === rows.length}
                    onChange={(e) => setPicked(e.target.checked ? rows.map((x) => x.id) : [])}
                  />
                </th>
              )}
              {columns.map((c) => (
                <th key={c.key} style={{ minWidth: c.width }}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={`${edits[row.id] ? 'row-changed' : ''} ${picked.includes(row.id) ? 'row-picked' : ''}`}>
                {picking && (
                  <td className="bulk-pick">
                    <input
                      type="checkbox"
                      aria-label="Marcar para eliminar"
                      checked={picked.includes(row.id)}
                      onChange={(e) => setPicked(e.target.checked ? [...picked, row.id] : picked.filter((x) => x !== row.id))}
                    />
                  </td>
                )}
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

      {notice && <p className="alert alert-ok pre-line">{notice}</p>}
      {error && <p className="alert alert-error pre-line">{error}</p>}
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
        {props.prefix && <span className="code-prefix">{props.prefix}</span>}
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

/**
 * Número propio de una ubicación dentro de otra: el principio (código de la
 * superior y prefijo del tipo) es fijo; solo se escribe el número.
 */
export function SeqInput(props: { fixed: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <span className="code-input code-input-big">
      <span className="code-prefix" title="Lo ponen la ubicación que la contiene y el tipo">{props.fixed}</span>
      <input
        className="seq-input"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value.replace(/\D/g, '').slice(0, 4))}
        onFocus={(e) => e.target.select()}
        inputMode="numeric"
        required
        autoFocus={props.autoFocus}
        aria-label="Número"
      />
    </span>
  );
}

/** «7» → «07», como lo guarda el sistema. */
export const padSeq = (v: string) => (v ? v.padStart(2, '0') : '');
