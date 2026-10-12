/** Placeholder for a sidebar page that isn't built yet. */
export function ComingSoon({ title, section }: { title: string; section?: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      {section && <div className="text-xs text-slate-400">{section}</div>}
      <h1 className="text-lg font-semibold">{title}</h1>
      <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-panel p-6">
        <div className="text-sm font-medium text-slate-700">Coming soon</div>
        <p className="mt-1 text-sm text-slate-500">This page isn’t built yet. It has a place in the sidebar so the menu matches the plan.</p>
      </div>
    </div>
  );
}
