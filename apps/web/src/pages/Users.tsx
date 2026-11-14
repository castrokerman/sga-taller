import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, formatDateTime, roleName, type AdminUser, type Role, type User } from '../api';
import { Highlight, useListControls, type ListConfig } from '../components/ListControls';

const userStatus = (u: AdminUser) =>
  !u.active ? 'off' : u.locked ? 'locked' : u.mustChangePassword ? 'provisional' : 'ok';

function usersConfig(roles: Role[]): ListConfig<AdminUser> {
  return {
    storageKey: 'usuarios',
    noun: 'usuarios',
    placeholder: 'Filtrar por nombre o usuario',
    text: (u) => [u.fullName, u.username, u.email],
    sorts: [
      { key: 'nombre', label: 'Nombre', value: (u) => u.fullName },
      { key: 'usuario', label: 'Usuario', value: (u) => u.username },
      { key: 'rol', label: 'Rol', value: (u) => u.roles.map(roleName).join(', ') },
      { key: 'acceso', label: 'Último acceso', value: (u) => (u.lastLoginAt ? Date.parse(u.lastLoginAt) : null), defaultDir: 'desc' },
      { key: 'alta', label: 'Fecha de alta', value: (u) => Date.parse(u.createdAt), defaultDir: 'desc' },
    ],
    filters: [
      {
        key: 'rol', label: 'Rol',
        options: roles.map((r) => ({ value: r.code, label: r.name })),
        test: (u, v) => u.roles.includes(v),
      },
      {
        key: 'estado', label: 'Estado',
        options: [
          { value: 'ok', label: 'Activo' },
          { value: 'provisional', label: 'Contraseña provisional' },
          { value: 'locked', label: 'Bloqueado' },
          { value: 'off', label: 'Desactivado' },
        ],
        test: (u, v) => userStatus(u) === v,
      },
    ],
  };
}

const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Ha ocurrido un error inesperado');

export function UsersPage({ me, back }: { me: User; back: () => void }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const list = useListControls(users ?? [], usersConfig(roles));

  const load = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([api.users(), api.roles()]);
      setUsers(u.users);
      setRoles(r.roles);
    } catch (e) {
      setError(message(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const done = async (text: string) => {
    setCreating(false);
    setEditing(null);
    setError(null);
    setNotice(text);
    await load();
  };

  const toggleActive = async (u: AdminUser) => {
    const verb = u.active ? 'desactivar' : 'activar';
    if (!window.confirm(`¿Seguro que quieres ${verb} a ${u.fullName}?`)) return;
    try {
      await api.updateUser(u.id, { active: !u.active });
      await done(`Usuario ${u.active ? 'desactivado' : 'activado'}: ${u.fullName}`);
    } catch (e) {
      setNotice(null);
      setError(message(e));
    }
  };

  return (
    <>
      <div className="page-head">
        <button className="btn" onClick={back}>
          ← Inicio
        </button>
        <h2>Usuarios</h2>
        <button className="btn btn-primary push-right" onClick={() => { setCreating(true); setEditing(null); setNotice(null); }}>
          Nuevo usuario
        </button>
      </div>

      {notice && <p className="alert alert-ok">{notice}</p>}
      {error && <p className="alert alert-error">{error}</p>}

      {creating && <CreateForm roles={roles} onCancel={() => setCreating(false)} onDone={done} />}
      {editing && <EditForm user={editing} roles={roles} onCancel={() => setEditing(null)} onDone={done} />}

      {!users && !error && <p className="muted">Cargando…</p>}

      {users && users.length > 1 && list.bar}
      {users && list.visible.length === 0 && <p className="muted">Ningún usuario cumple los filtros.</p>}
      {users && list.visible.length > 0 && (
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Usuario</th>
                <th>Roles</th>
                <th>Estado</th>
                <th>Último acceso</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.visible.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'row-off'}>
                  <td><Highlight text={u.fullName} query={list.query} /></td>
                  <td className="mono"><Highlight text={u.username} query={list.query} /></td>
                  <td>{u.roles.map(roleName).join(', ') || '—'}</td>
                  <td>
                    {!u.active ? (
                      <span className="badge badge-off">Desactivado</span>
                    ) : u.locked ? (
                      <span className="badge badge-warn">Bloqueado</span>
                    ) : u.mustChangePassword ? (
                      <span className="badge badge-warn">Contraseña provisional</span>
                    ) : (
                      <span className="badge badge-ok">Activo</span>
                    )}
                  </td>
                  <td className="nowrap">{formatDateTime(u.lastLoginAt)}</td>
                  <td className="row-actions">
                    <button className="btn btn-small" onClick={() => { setEditing(u); setCreating(false); setNotice(null); }}>
                      Editar
                    </button>
                    {u.id !== me.id && (
                      <button className="btn btn-small" onClick={() => toggleActive(u)}>
                        {u.active ? 'Desactivar' : 'Activar'}
                      </button>
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

function RolePicker(props: { roles: Role[]; value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (code: string) =>
    props.onChange(props.value.includes(code) ? props.value.filter((c) => c !== code) : [...props.value, code]);
  return (
    <fieldset className="field">
      <legend>Roles</legend>
      {props.roles.map((r) => (
        <label key={r.code} className="check">
          <input type="checkbox" checked={props.value.includes(r.code)} onChange={() => toggle(r.code)} />
          <span>
            <strong>{r.name}</strong>
            {r.description && <small className="muted"> — {r.description}</small>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function CreateForm(props: { roles: Role[]; onCancel: () => void; onDone: (text: string) => void }) {
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [selected, setSelected] = useState<string[]>(['USUARIO']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (selected.length === 0) return setError('Elige al menos un rol');
    setBusy(true);
    setError(null);
    try {
      await api.createUser({ username: username.trim().toLowerCase(), fullName, password, roles: selected });
      props.onDone(`Usuario creado: ${fullName}. Deberá cambiar la contraseña la primera vez que entre.`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h3>Nuevo usuario</h3>
      <div className="grid-2">
        <label className="field">
          <span>Nombre y apellidos</span>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} required autoFocus maxLength={150} />
        </label>
        <label className="field">
          <span>Nombre de usuario</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{2,49}"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <small className="muted">Letras, números, punto o guion. Mínimo 3 caracteres.</small>
        </label>
      </div>
      <label className="field">
        <span>Contraseña provisional</span>
        <input value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="off" />
        <small className="muted">Mínimo 10 caracteres. El usuario tendrá que cambiarla al entrar.</small>
      </label>
      <RolePicker roles={props.roles} value={selected} onChange={setSelected} />

      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Creando…' : 'Crear usuario'}
        </button>
      </div>
    </form>
  );
}

function EditForm(props: { user: AdminUser; roles: Role[]; onCancel: () => void; onDone: (text: string) => void }) {
  const { user } = props;
  const [fullName, setFullName] = useState(user.fullName);
  const [selected, setSelected] = useState<string[]>(user.roles);
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (selected.length === 0) return setError('Elige al menos un rol');
    setBusy(true);
    setError(null);
    try {
      await api.updateUser(user.id, { fullName, roles: selected });
      props.onDone(`Cambios guardados: ${fullName}`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (newPassword.length < 10) return setError('La contraseña provisional debe tener al menos 10 caracteres');
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(user.id, newPassword);
      props.onDone(`Contraseña restablecida: ${user.fullName}. Deberá cambiarla al entrar.`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={save}>
      <h3>
        Editar usuario <span className="mono muted">{user.username}</span>
      </h3>
      <label className="field">
        <span>Nombre y apellidos</span>
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} required maxLength={150} />
      </label>
      <RolePicker roles={props.roles} value={selected} onChange={setSelected} />

      <fieldset className="field">
        <legend>Restablecer contraseña</legend>
        <div className="inline">
          <input
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Nueva contraseña provisional"
            autoComplete="off"
          />
          <button type="button" className="btn" onClick={reset} disabled={busy || !newPassword}>
            Restablecer
          </button>
        </div>
        <small className="muted">También desbloquea la cuenta y cierra sus sesiones abiertas.</small>
      </fieldset>

      {error && <p className="alert alert-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancelar
        </button>
        <button className="btn btn-primary" disabled={busy}>
          Guardar cambios
        </button>
      </div>
    </form>
  );
}
