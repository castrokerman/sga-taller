import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, roleName, type User } from './api';
import { AuditPage } from './pages/Audit';
import { ChangePasswordPage } from './pages/ChangePassword';
import { ContainerPage } from './pages/Container';
import { FamiliesPage } from './pages/Families';
import { LoansPage } from './pages/Loans';
import { MaterialPage } from './pages/Material';
import { MaterialsPage } from './pages/Materials';
import { MovementsPage } from './pages/Movements';
import { NotificationsPage } from './pages/Notifications';
import { HomePage } from './pages/Home';
import { LoginPage } from './pages/Login';
import { ScannerPage } from './pages/ScannerPage';
import { TypesPage } from './pages/Types';
import { UsersPage } from './pages/Users';
import { WarehousePage } from './pages/Warehouse';
import { navigate, useRoute } from './router';

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [unread, setUnread] = useState(0);
  const route = useRoute();

  // Avisos sin leer: al cambiar de pantalla y cada minuto.
  const refreshUnread = useCallback(() => {
    api.unreadCount().then((r) => setUnread(r.unread)).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!user || user.mustChangePassword) return;
    refreshUnread();
    const t = window.setInterval(refreshUnread, 60_000);
    return () => window.clearInterval(t);
  }, [user, route.name, route.id, refreshUnread]);

  const refresh = useCallback(async () => {
    try {
      setUser((await api.me()).user);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    navigate('inicio');
  };

  if (loading) return <div className="centered muted">Cargando…</div>;
  if (!user) return <LoginPage onLogin={setUser} />;

  // Con contraseña provisional solo se puede cambiarla.
  if (user.mustChangePassword) {
    return (
      <Shell user={user} onLogout={logout}>
        <ChangePasswordPage forced onDone={refresh} />
      </Shell>
    );
  }

  const can = (p: string) => user.permissions.includes(p);
  const home = () => navigate('inicio');

  // Cada pantalla comprueba el permiso; el servidor lo vuelve a comprobar siempre.
  let page: React.ReactNode;
  if (route.name === 'almacen' && can('location.read')) page = <WarehousePage user={user} locationId={route.id} />;
  else if (route.name === 'contenedor' && route.id && can('container.read')) page = <ContainerPage user={user} containerId={route.id} />;
  else if (route.name === 'materiales' && can('material.read')) page = <MaterialsPage user={user} />;
  else if (route.name === 'material' && route.id && can('material.read')) page = <MaterialPage user={user} materialId={route.id} />;
  else if (route.name === 'familias' && can('material.read')) page = <FamiliesPage user={user} />;
  else if (route.name === 'movimientos' && can('stock.read')) page = <MovementsPage user={user} />;
  else if (route.name === 'prestamos' && can('stock.read')) page = <LoansPage user={user} />;
  else if (route.name === 'escaner' && can('container.read')) page = <ScannerPage />;
  else if (route.name === 'usuarios' && can('admin.users.manage')) page = <UsersPage me={user} back={home} />;
  else if (route.name === 'auditoria' && can('audit.read')) page = <AuditPage back={home} />;
  else if (route.name === 'tipos' && can('admin.masterdata.manage')) page = <TypesPage />;
  else if (route.name === 'avisos') page = <NotificationsPage onChanged={refreshUnread} />;
  else if (route.name === 'contrasena') page = <ChangePasswordPage onDone={home} onCancel={home} />;
  else page = <HomePage user={user} />;

  return (
    <Shell user={user} onLogout={logout} withNav unread={unread}>
      {page}
    </Shell>
  );
}

function Shell(props: { user: User; onLogout: () => void; withNav?: boolean; unread?: number; children: React.ReactNode }) {
  const { user } = props;
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href={props.withNav ? '#/inicio' : undefined}>
          <img className="brand-logo" src="/logo-idom.png" alt="IDOM" />
          <span className="brand-text">
            <strong>ADA</strong>
            <span>Sistema de gestión de almacén</span>
          </span>
        </a>
        <div className="topbar-user">
          <div className="who">
            <strong>{user.fullName}</strong>
            <span>{user.roles.map(roleName).join(' · ') || 'Sin rol'}</span>
          </div>
          {props.withNav && (
            <a className={`btn btn-ghost bell ${props.unread ? 'bell-on' : ''}`} href="#/avisos" title="Avisos" aria-label={`Avisos: ${props.unread ?? 0} sin leer`}>
              <span aria-hidden="true">🔔</span>
              {props.unread ? <b className="bell-count">{props.unread > 99 ? '99+' : props.unread}</b> : null}
            </a>
          )}
          {props.withNav && (
            <a className="btn btn-ghost" href="#/contrasena" title="Cambiar contraseña" aria-label="Cambiar contraseña">
              <span className="lbl-long">Contraseña</span>
              <span className="lbl-short" aria-hidden="true">🔑</span>
            </a>
          )}
          <button className="btn btn-ghost" onClick={props.onLogout}>
            Salir
          </button>
        </div>
      </header>
      <main className="content">{props.children}</main>
    </div>
  );
}
