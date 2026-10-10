import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { UNAUTHORIZED_EVENT, api, type AuthUser } from '../api';

interface AuthState {
  user: AuthUser;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);
export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthGate');
  return ctx;
};

/**
 * Wraps the app: shows first-run setup or sign-in until there is a session,
 * and drops back to sign-in whenever an API call returns 401.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'setup' | 'login' | 'in'>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.authStatus();
      if (s.setupRequired) setState('setup');
      else if (s.user) {
        setUser(s.user);
        setState('in');
      } else setState('login');
    } catch {
      setState('login');
    }
  }, []);

  useEffect(() => {
    refresh();
    const onUnauthorized = () => {
      setUser(null);
      setState('login');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [refresh]);

  const signOut = async () => {
    await api.logout().catch(() => {});
    setUser(null);
    setState('login');
  };

  if (state === 'loading') return <div className="flex h-full items-center justify-center text-sm text-slate-400">Loading…</div>;
  if (state === 'setup') return <AuthScreen mode="setup" onDone={refresh} />;
  if (state === 'login' || !user) return <AuthScreen mode="login" onDone={refresh} />;
  if (user.mustChangePassword) return <ChangePasswordScreen onDone={refresh} />;
  return <AuthContext.Provider value={{ user, signOut, refresh }}>{children}</AuthContext.Provider>;
}

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <span className="inline-block h-7 w-7 rounded-md bg-indigo-600" aria-hidden />
          <div>
            <div className="text-base font-semibold tracking-tight">Sweyt Incentive</div>
            <div className="text-xs text-slate-400">commissions & incentives</div>
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-panel p-5 shadow-sm">
          <h1 className="text-sm font-semibold">{title}</h1>
          <p className="mb-4 mt-0.5 text-xs text-slate-500">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

function AuthScreen({ mode, onDone }: { mode: 'setup' | 'login'; onDone: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'setup') await api.setup({ email, name, password });
      else await api.login({ email, password });
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell
      title={mode === 'setup' ? 'Create the admin account' : 'Sign in'}
      subtitle={mode === 'setup' ? 'No accounts exist yet. This first account becomes the administrator.' : 'Use the email and password for your account.'}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {mode === 'setup' && (
          <label className="block text-xs text-slate-600">
            Your name
            <input className="input mt-1 block w-full" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </label>
        )}
        <label className="block text-xs text-slate-600">
          Email
          <input type="email" className="input mt-1 block w-full" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required />
        </label>
        <label className="block text-xs text-slate-600">
          Password {mode === 'setup' && <span className="text-slate-400">(at least 10 characters)</span>}
          <input
            type="password"
            className="input mt-1 block w-full"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            minLength={mode === 'setup' ? 10 : 1}
            required
          />
        </label>
        {error && <div className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{error}</div>}
        <button type="submit" className="btn btn-primary w-full justify-center" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'setup' ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </Shell>
  );
}

function ChangePasswordScreen({ onDone }: { onDone: () => Promise<void> }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Choose a new password" subtitle="You signed in with a temporary password. Pick your own to continue.">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="block text-xs text-slate-600">
          Temporary password
          <input type="password" className="input mt-1 block w-full" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus required />
        </label>
        <label className="block text-xs text-slate-600">
          New password <span className="text-slate-400">(at least 10 characters)</span>
          <input type="password" className="input mt-1 block w-full" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} required />
        </label>
        {error && <div className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{error}</div>}
        <button type="submit" className="btn btn-primary w-full justify-center" disabled={busy}>
          Save password
        </button>
      </form>
    </Shell>
  );
}
