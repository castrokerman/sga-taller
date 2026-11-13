import type { Page } from '../App';
import type { User } from '../api';

interface Tile {
  title: string;
  text: string;
  page?: Page;
  permission?: string;
  phase?: number;
}

const TILES: Tile[] = [
  { title: 'Escáner QR', text: 'Escanear ubicaciones y contenedores', phase: 2 },
  { title: 'Almacén', text: 'Ubicaciones y contenedores', phase: 2 },
  { title: 'Buscador', text: 'Materiales, lotes y proyectos', phase: 3 },
  { title: 'Movimientos', text: 'Entradas, salidas y traslados', phase: 3 },
  { title: 'Autorizaciones', text: 'Solicitudes de material restringido', phase: 4 },
  { title: 'Documentación', text: 'Certificados y documentos técnicos', phase: 5 },
  { title: 'Usuarios', text: 'Altas, roles y contraseñas', page: 'usuarios', permission: 'admin.users.manage' },
  { title: 'Auditoría', text: 'Quién hizo qué y cuándo', page: 'auditoria', permission: 'audit.read' },
];

export function HomePage({ user, go }: { user: User; go: (page: Page) => void }) {
  const can = (permission?: string) => !permission || user.permissions.includes(permission);
  // Primero lo que ya se puede usar; después lo que llegará en fases posteriores.
  const tiles = [
    ...TILES.filter((t) => t.page && can(t.permission)),
    ...TILES.filter((t) => t.phase !== undefined),
  ];

  return (
    <>
      <h2>Hola, {user.fullName.split(' ')[0]}</h2>
      <p className="muted">
        El sistema está en construcción. Las funciones de almacén se irán activando fase a fase.
      </p>

      <div className="tiles">
        {tiles.map((t) =>
          t.page ? (
            <button key={t.title} className="tile tile-active" onClick={() => go(t.page!)}>
              <strong>{t.title}</strong>
              <span>{t.text}</span>
            </button>
          ) : (
            <div key={t.title} className="tile tile-pending" aria-disabled="true">
              <strong>{t.title}</strong>
              <span>{t.text}</span>
              <em>Disponible en la fase {t.phase}</em>
            </div>
          ),
        )}
      </div>
    </>
  );
}
