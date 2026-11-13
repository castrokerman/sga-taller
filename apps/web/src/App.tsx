import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, roleName, type User } from './api';
import { AuditPage } from './pages/Audit';
import { ChangePasswordPage } from './pages/ChangePassword';
import { HomePage } from './pages/Home';
import { LoginPage } from './pages/Login';
import { UsersPage } from './pages/Users';

export type Page = 'inicio' | 'usuarios' | 'auditoria' | 'contrasena';

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>('inicio');

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
    setPage('inicio');
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

  return (
    <Shell user={user} onLogout={logout} onHome={() => setPage('inicio')} onPassword={() => setPage('contrasena')}>
      {page === 'inicio' && <HomePage user={user} go={setPage} />}
      {page === 'usuarios' && <UsersPage me={user} back={() => setPage('inicio')} />}
      {page === 'auditoria' && <AuditPage back={() => setPage('inicio')} />}
      {page === 'contrasena' && <ChangePasswordPage onDone={() => setPage('inicio')} onCancel={() => setPage('inicio')} />}
    </Shell>
  );
}

function Shell(props: {
  user: User;
  onLogout: () => void;
  onHome?: () => void;
  onPassword?: () => void;
  children: React.ReactNode;
}) {
  const { user } = props;
  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand" onClick={props.onHome} disabled={!props.onHome}>
          <img src="/icono.svg" alt="" width="36" height="36" />
          <span>SGA Taller</span>
        </button>
        <div className="topbar-user">
          <div className="who">
            <strong>{user.fullName}</strong>
            <span>{user.roles.map(roleName).join(' · ') || 'Sin rol'}</span>
          </div>
          {props.onPassword && (
            <button className="btn btn-ghost" onClick={props.onPassword}>
              Contraseña
            </button>
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
