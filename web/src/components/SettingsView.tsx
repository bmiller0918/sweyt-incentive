import { CompPlansView } from './CompPlansView';
import { UsersSettings } from './UsersSettings';

export type SettingsTab = 'plans' | 'users';

export function SettingsView({ tab }: { tab: SettingsTab }) {
  if (tab === 'plans') return <CompPlansView />;
  return <UsersSettings />;
}
