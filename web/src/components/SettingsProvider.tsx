import { DEFAULT_APP_SETTINGS, type AppSettings, type FeatureKey, type PermissionKey, type QuickActionKey } from '@commissions/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAuth } from './AuthGate';

interface SettingsState {
  settings: AppSettings;
  /** Re-read from the server (after a save on the Setup page). */
  refresh: () => Promise<AppSettings>;
  /** Is a system feature switched on? */
  feature: (key: FeatureKey) => boolean;
  /** Is a quick access button on a run switched on? */
  quick: (key: QuickActionKey) => boolean;
  /** May the signed-in user do this? Admins always can. */
  can: (key: PermissionKey) => boolean;
}

const SettingsContext = createContext<SettingsState | null>(null);
export const useSettings = () => {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings outside SettingsProvider');
  return ctx;
};

/** Loads the global settings once a user is signed in; the sidebar and pages read them from here. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSettings(s);
      return s;
    } catch {
      // The app still works on defaults if the settings can't be read.
      setSettings(DEFAULT_APP_SETTINGS);
      return DEFAULT_APP_SETTINGS;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo<SettingsState | null>(() => {
    if (!settings) return null;
    return {
      settings,
      refresh,
      feature: (k) => settings.features[k],
      quick: (k) => settings.quickActions[k],
      can: (k) => user.role === 'admin' || settings.permissions[k] === 'all',
    };
  }, [settings, refresh, user.role]);

  if (!value) return <div className="flex h-full items-center justify-center text-sm text-slate-400">Loading…</div>;
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
