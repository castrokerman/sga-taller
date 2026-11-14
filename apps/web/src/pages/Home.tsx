import type { User } from '../api';

interface Tile {
  title: string;
  text: string;
  /** Pantalla a la que lleva. Sin ella, la función aún no está disponible. */
  path?: string;
  permission?: string;
  /** Fase en la que llega, o «más adelante» si aún no tiene fase. */
  phase?: number | 'later';
}

const TILES: Tile[] = [
  { title: 'Escáner QR', text: 'Escanear ubicaciones y contenedores', path: 'escaner', permission: 'container.read' },
  { title: 'Almacén', text: 'Ubicaciones y contenedores', path: 'almacen', permission: 'location.read' },
  { title: 'Buscador', text: 'Materiales, lotes y proyectos', phase: 3 },
  { title: 'Mapa', text: 'Plano del taller para ir a cada zona', phase: 'later' },
  { title: 'Movimientos', text: 'Entradas, salidas y traslados', phase: 3 },
  { title: 'Autorizaciones', text: 'Solicitudes de material restringido', phase: 4 },
  { title: 'Documentación', text: 'Certificados y documentos técnicos', phase: 5 },
  { title: 'Usuarios', text: 'Altas, roles y contraseñas', path: 'usuarios', permission: 'admin.users.manage' },
  { title: 'Tipos', text: 'Tipos de ubicación y de contenedor', path: 'tipos', permission: 'admin.masterdata.manage' },
  { title: 'Auditoría', text: 'Quién hizo qué y cuándo', path: 'auditoria', permission: 'audit.read' },
];

export function HomePage({ user }: { user: User }) {
  const can = (permission?: string) => !permission || user.permissions.includes(permission);
  // Primero lo que ya se puede usar; después lo que llegará en fases posteriores.
  const tiles = [...TILES.filter((t) => t.path && can(t.permission)), ...TILES.filter((t) => t.phase !== undefined)];

  return (
    <>
      <h2>Hola, {user.fullName.split(' ')[0]}</h2>
      <p className="muted">El sistema está en construcción. El registro de material llega en la Fase 3.</p>

      <div className="tiles">
        {tiles.map((t) =>
          t.path ? (
            <a key={t.title} className="tile tile-active" href={`#/${t.path}`}>
              <strong>{t.title}</strong>
              <span>{t.text}</span>
            </a>
          ) : (
            <div key={t.title} className="tile tile-pending" aria-disabled="true">
              <strong>{t.title}</strong>
              <span>{t.text}</span>
              <em>{t.phase === 'later' ? 'Próximamente' : `Disponible en la fase ${t.phase}`}</em>
            </div>
          ),
        )}
      </div>
    </>
  );
}
