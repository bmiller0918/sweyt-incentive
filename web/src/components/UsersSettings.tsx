import { useEffect, useState } from 'react';
import { api, type AuthUser } from '../api';
import { useAuth } from './AuthGate';

type Row = AuthUser & { lastLoginAt: string | null; createdAt: string };

export function UsersSettings() {
  const { user: me } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [created, setCreated] = useState<{ email: string; tempPassword: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwMsg, setPwMsg] = useState<string | null>(null);

  const refresh = () => api.listUsers().then(setRows).catch((e) => setError(e.message));
  useEffect(() => {
    if (me.role === 'admin') refresh();
  }, [me.role]);

  const add = async () => {
    setError(null);
    try {
      const r = await api.createUser({ email: email.trim(), name: name.trim(), role });
      setCreated({ email: r.user.email, tempPassword: r.tempPassword });
      setEmail('');
      setName('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const changePw = async () => {
    setPwMsg(null);
    try {
      await api.changePassword({ currentPassword: pw.current, newPassword: pw.next });
      setPw({ current: '', next: '' });
      setPwMsg('Password changed. Other devices were signed out.');
    } catch (e) {
      setPwMsg((e as Error).message);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 p-6">
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Your account</h2>
          <p className="text-xs text-slate-500">
            Signed in as <strong>{me.name}</strong> ({me.email}) · {me.role}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-panel p-3 text-xs">
          <label className="text-slate-600">
            Current password
            <input type="password" className="input mt-1 block w-44" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
          </label>
          <label className="text-slate-600">
            New password <span className="text-slate-400">(10+ chars)</span>
            <input type="password" className="input mt-1 block w-44" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
          </label>
          <button className="btn" disabled={!pw.current || pw.next.length < 10} onClick={changePw}>
            Change password
          </button>
          {pwMsg && <span className="text-slate-500">{pwMsg}</span>}
        </div>
      </section>

      {me.role === 'admin' && (
        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">Users</h2>
            <p className="text-xs text-slate-500">Who can sign in. New users get a temporary password shown once; they must change it on first sign-in.</p>
          </div>
          {error && <div className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{error}</div>}
          <table className="w-full text-xs">
            <thead className="text-left text-slate-400">
              <tr className="border-b border-slate-200">
                <th className="py-2 pr-3 font-normal">Name</th>
                <th className="py-2 pr-3 font-normal">Email</th>
                <th className="py-2 pr-3 font-normal">Role</th>
                <th className="py-2 pr-3 font-normal">Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-medium">
                    {u.name}
                    {u.id === me.id && <span className="ml-1 text-slate-400">(you)</span>}
                  </td>
                  <td className="py-2 pr-3">{u.email}</td>
                  <td className="py-2 pr-3">
                    {u.role}
                    {u.mustChangePassword && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">temp password</span>}
                  </td>
                  <td className="py-2 pr-3 text-slate-500">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</td>
                  <td className="py-2 text-right">
                    {u.id !== me.id && (
                      <button
                        className="text-slate-400 hover:text-rose-600"
                        onClick={async () => {
                          if (!window.confirm(`Remove ${u.email}? They will be signed out immediately.`)) return;
                          await api.deleteUser(u.id).catch((e) => setError(e.message));
                          refresh();
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-panel p-3 text-xs">
            <label className="text-slate-600">
              Name
              <input className="input mt-1 block w-40" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="text-slate-600">
              Email
              <input type="email" className="input mt-1 block w-56" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="text-slate-600">
              Role
              <select className="select mt-1 block" value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')}>
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <button className="btn btn-primary" disabled={!email.trim() || !name.trim()} onClick={add}>
              Add user
            </button>
          </div>
          {created && (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-800">
              <div className="font-semibold">Account created for {created.email}</div>
              <div className="mt-1">
                Temporary password (shown once — send it to them securely): <code className="select-all font-mono">{created.tempPassword}</code>
              </div>
              <button className="mt-2 underline" onClick={() => setCreated(null)}>
                dismiss
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
