import { useEffect, useState } from 'react';
import { api, type User } from '../api';

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
  { title: 'Buscador', text: 'Buscar cualquier cosa por palabras y ver dónde está', path: 'buscar', permission: 'location.read' },
  { title: 'Registrar entrada', text: 'Lo que llega: identificarlo ya, o foto y aviso a su responsable', path: 'entrada', permission: 'stock.receive' },
  { title: 'Recepciones', text: 'Lo que ha llegado y falta por identificar', path: 'recepciones' },
  { title: 'Escáner QR', text: 'Escanear ubicaciones y contenedores', path: 'escaner', permission: 'container.read' },
  { title: 'Almacén', text: 'Ubicaciones y contenedores', path: 'almacen', permission: 'location.read' },
  { title: 'Contenidos', text: 'Catálogo, dónde está cada cosa y cuánto hay', path: 'contenidos', permission: 'material.read' },
  { title: 'Movimientos', text: 'Entradas, retiradas, traslados y recuentos', path: 'movimientos', permission: 'stock.read' },
  { title: 'Préstamos', text: 'Herramientas prestadas y fechas de devolución', path: 'prestamos', permission: 'stock.read' },
  { title: 'Mapa', text: 'Plano del taller para ir a cada zona', phase: 'later' },
  { title: 'Autorizaciones', text: 'Solicitudes de contenido restringido', phase: 4 },
  { title: 'Documentación', text: 'Certificados y documentos técnicos', phase: 5 },
  { title: 'Usuarios', text: 'Altas, roles y contraseñas', path: 'usuarios', permission: 'admin.users.manage' },
  { title: 'Tipos', text: 'Tipos de ubicación y de contenedor', path: 'tipos', permission: 'admin.masterdata.manage' },
  { title: 'Auditoría', text: 'Quién hizo qué y cuándo', path: 'auditoria', permission: 'audit.read' },
];

export function HomePage({ user }: { user: User }) {
  const can = (permission?: string) => !permission || user.permissions.includes(permission);
  // Primero lo que ya se puede usar; después lo que llegará en fases posteriores.
  const tiles = [...TILES.filter((t) => t.path && can(t.permission)), ...TILES.filter((t) => t.phase !== undefined)];
  const [pending, setPending] = useState<{ mine: number; received: number; total: number | null } | null>(null);
  useEffect(() => {
    api.inboundCount().then(setPending).catch(() => undefined);
  }, []);
  const badge = (t: Tile) => (t.path === 'recepciones' && pending ? (pending.total ?? pending.mine + pending.received) : 0);

  return (
    <>
      <h2>Hola, {user.fullName.split(' ')[0]}</h2>
      <p className="muted">Escanea una caja o una ubicación para ver qué hay y sacar o meter contenido.</p>
      {pending && pending.mine > 0 && (
        <a className="alert alert-warn todo-banner" href="#/recepciones">
          <span>
            Tienes <strong>{pending.mine === 1 ? 'una recepción' : `${pending.mine} recepciones`}</strong> por identificar: ha llegado algo a tu nombre.
          </span>
          <span className="btn btn-primary">Identificar</span>
        </a>
      )}

      <div className="tiles">
        {tiles.map((t) =>
          t.path ? (
            <a key={t.title} className="tile tile-active" href={`#/${t.path}`}>
              <strong>
                {t.title}
                {badge(t) > 0 && <b className="tile-count">{badge(t)}</b>}
              </strong>
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
