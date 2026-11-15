import { useEffect, useState } from 'react';
import { api, type User } from '../api';

interface Tile {
  icon: string;
  title: string;
  text: string;
  path: string;
  permission?: string;
}

interface Group {
  title: string;
  text: string;
  /** Si se pone, el bloque solo se enseña a quien tiene este permiso (además del de cada tarjeta). */
  permission?: string;
  tiles: Tile[];
}

/**
 * El inicio se ordena en bloques por función. Cada persona ve solo los bloques
 * y las tarjetas que le tocan según sus permisos: un usuario de taller no ve
 * «Control» ni «Administración».
 */
const GROUPS: Group[] = [
  {
    title: 'Día a día',
    text: 'lo que se hace a diario',
    tiles: [
      { icon: '📷', title: 'Escáner QR', text: 'Escanear cajas y ubicaciones', path: 'escaner', permission: 'container.read' },
      { icon: '📥', title: 'Registrar entrada', text: 'Lo que llega al taller', path: 'entrada', permission: 'stock.receive' },
      { icon: '📬', title: 'Recepciones', text: 'Lo que falta por identificar', path: 'recepciones' },
      { icon: '🔎', title: 'Buscador', text: 'Dónde está cada cosa', path: 'buscar', permission: 'location.read' },
    ],
  },
  {
    title: 'Inventario',
    text: 'consultar qué hay y dónde',
    tiles: [
      { icon: '🏭', title: 'Almacén', text: 'Ubicaciones y contenedores', path: 'almacen', permission: 'location.read' },
      { icon: '📦', title: 'Contenidos', text: 'Catálogo y cuánto hay', path: 'contenidos', permission: 'material.read' },
      { icon: '🔧', title: 'Préstamos', text: 'Quién tiene qué y hasta cuándo', path: 'prestamos', permission: 'stock.read' },
      { icon: '📁', title: 'Proyectos', text: 'Sus responsables y lo reservado', path: 'proyectos', permission: 'project.read' },
    ],
  },
  {
    title: 'Control',
    text: 'seguimiento y trazabilidad',
    permission: 'audit.read',
    tiles: [
      { icon: '🔁', title: 'Movimientos', text: 'Entradas, salidas, traslados y recuentos', path: 'movimientos', permission: 'stock.read' },
      { icon: '🕘', title: 'Auditoría', text: 'Quién hizo qué y cuándo', path: 'auditoria', permission: 'audit.read' },
    ],
  },
  {
    title: 'Administración',
    text: 'configuración del sistema',
    tiles: [
      { icon: '👥', title: 'Usuarios', text: 'Altas, roles y bajas', path: 'usuarios', permission: 'admin.users.manage' },
      { icon: '🏷️', title: 'Tipos', text: 'Prefijos y códigos', path: 'tipos', permission: 'admin.masterdata.manage' },
      { icon: '🗂️', title: 'Familias', text: 'Clasificación del catálogo', path: 'familias', permission: 'admin.masterdata.manage' },
    ],
  },
];

export function HomePage({ user }: { user: User }) {
  const can = (permission?: string) => !permission || user.permissions.includes(permission);
  const [pending, setPending] = useState<{ mine: number; received: number; total: number | null } | null>(null);
  useEffect(() => {
    api.inboundCount().then(setPending).catch(() => undefined);
  }, []);

  // En la tarjeta de Recepciones: todas las pendientes para quien las gestiona; las suyas para los demás.
  const pendingCount = pending ? (pending.total ?? pending.mine + pending.received) : 0;
  const groups = GROUPS.filter((g) => can(g.permission))
    .map((g) => ({ ...g, tiles: g.tiles.filter((t) => can(t.permission)) }))
    .filter((g) => g.tiles.length > 0);

  const intro =
    pending && pending.total
      ? `Hay ${pending.total === 1 ? 'una recepción pendiente' : `${pending.total} recepciones pendientes`} de identificar en el almacén.`
      : 'Escanea una caja o una ubicación para ver qué hay y sacar o meter contenido.';

  return (
    <>
      <h2>Hola, {user.fullName.split(' ')[0]}</h2>
      <p className="muted">{intro}</p>
      {pending && pending.mine > 0 && (
        <a className="alert alert-warn todo-banner" href="#/recepciones">
          <span>
            Tienes <strong>{pending.mine === 1 ? 'una recepción' : `${pending.mine} recepciones`}</strong> por identificar: ha llegado algo a tu nombre.
          </span>
          <span className="btn btn-primary">Identificar</span>
        </a>
      )}

      {groups.map((g) => (
        <section key={g.title} className="home-group">
          <h3>
            {g.title} <span>{g.text}</span>
          </h3>
          <div className="tiles">
            {g.tiles.map((t) => (
              <a key={t.title} className="tile tile-active" href={`#/${t.path}`}>
                <strong>
                  <span className="tile-icon" aria-hidden="true">{t.icon}</span>
                  {t.title}
                  {t.path === 'recepciones' && pendingCount > 0 && <b className="tile-count">{pendingCount}</b>}
                </strong>
                <span>
                  {t.path === 'prestamos' && !can('loan.read_all')
                    ? 'Lo que tienes prestado'
                    : t.path === 'proyectos' && !can('project.manage')
                      ? 'Los proyectos en los que estás'
                      : t.text}
                </span>
              </a>
            ))}
          </div>
        </section>
      ))}

      <p className="home-soon">Próximamente: Mapa del taller · Autorizaciones (fase 4) · Documentación (fase 5)</p>
    </>
  );
}
