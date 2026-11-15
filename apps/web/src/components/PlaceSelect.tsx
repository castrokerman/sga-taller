import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage, type PlaceRef, type TreeContainer, type TreeLocation } from '../api';

export type PickedPlace = { ref: PlaceRef; code: string };

interface Option {
  value: string;
  label: string;
  place: PickedPlace;
}
interface Group {
  label: string;
  options: Option[];
}

/**
 * Lista desplegable con todos los sitios donde se puede dejar algo: un grupo
 * por zona, con sus ubicaciones activas en orden y, tras cada una, sus
 * contenedores. Sin espacios delante: el código ya dice dónde está cada cosa,
 * y así se lee bien una vez elegido.
 */
export function PlaceSelect(props: { value: PickedPlace | null; onChange: (p: PickedPlace | null) => void; autoFocus?: boolean }) {
  const [data, setData] = useState<{ locations: TreeLocation[]; containers: TreeContainer[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.tree().then(setData).catch((e) => setError(errorMessage(e)));
  }, []);

  const groups = useMemo(() => {
    if (!data) return [] as Group[];
    const locKids = new Map<string | null, TreeLocation[]>();
    for (const l of data.locations.filter((x) => x.active)) locKids.set(l.parentId, [...(locKids.get(l.parentId) ?? []), l]);
    const contIn = new Map<string, TreeContainer[]>();
    for (const c of data.containers) {
      const k = c.parentContainerId ? `c:${c.parentContainerId}` : `l:${c.locationId}`;
      contIn.set(k, [...(contIn.get(k) ?? []), c]);
    }
    const byCode = <T extends { code: string }>(a: T, b: T) => a.code.localeCompare(b.code, 'es', { numeric: true });
    const locOption = (l: TreeLocation): Option => ({
      value: `l:${l.id}`, label: `${l.code}${l.name ? ` · ${l.name}` : ''}`, place: { ref: { locationId: l.id }, code: l.code },
    });

    const out: Group[] = [];
    for (const zone of (locKids.get(null) ?? []).sort(byCode)) {
      const options: Option[] = [];
      const addContainers = (key: string) => {
        for (const c of (contIn.get(key) ?? []).sort(byCode)) {
          options.push({
            value: `c:${c.id}`,
            label: `↳ ▣ ${c.code}${c.description ? ` · ${c.description}` : ''}`,
            place: { ref: { containerId: c.id }, code: c.code },
          });
          addContainers(`c:${c.id}`);
        }
      };
      const addLocations = (parent: string) => {
        for (const l of (locKids.get(parent) ?? []).sort(byCode)) {
          options.push(locOption(l));
          addContainers(`l:${l.id}`);
          addLocations(l.id);
        }
      };
      options.push(locOption(zone));
      addContainers(`l:${zone.id}`);
      addLocations(zone.id);
      out.push({ label: `${zone.code}${zone.name ? ` · ${zone.name}` : ''}`, options });
    }
    return out;
  }, [data]);

  const current = props.value ? (props.value.ref.containerId ? `c:${props.value.ref.containerId}` : `l:${props.value.ref.locationId}`) : '';

  if (error) return <p className="alert alert-error">{error}</p>;
  return (
    <select
      className="place-select"
      value={current}
      autoFocus={props.autoFocus}
      disabled={!data}
      onChange={(e) => props.onChange(groups.flatMap((g) => g.options).find((o) => o.value === e.target.value)?.place ?? null)}
    >
      <option value="">{data ? 'Elige el sitio…' : 'Cargando sitios…'}</option>
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
