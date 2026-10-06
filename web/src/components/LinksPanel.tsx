import { AGG_FNS, AGG_LABELS, aggregateLabel, familyOf, type Aggregate, type ColumnDef } from '@commissions/shared';
import { useEffect, useState } from 'react';
import { api, type ImportLink, type ImportSummary, type LinkSummary } from '../api';
import { newId } from './CriteriaBuilder';

interface Props {
  importId: string;
  importName: string;
  /** The import's own (non-linked) columns. */
  ownColumns: ColumnDef[];
  onChanged: () => void;
  onClose: () => void;
}

/** Guess the key column: "ID", "Deal ID", "…Id", else the first column. */
function guessKey(cols: string[], hint?: string): string {
  if (hint) {
    const exact = cols.find((c) => c.toLowerCase() === hint.toLowerCase());
    if (exact) return exact;
  }
  return cols.find((c) => /(^|[^a-z])id$/i.test(c.trim())) ?? cols.find((c) => /\bid\b|key|number|#/i.test(c)) ?? cols[0] ?? '';
}

export function LinksPanel({ importId, importName, ownColumns, onChanged, onClose }: Props) {
  const [links, setLinks] = useState<LinkSummary | null>(null);
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [parentCols, setParentCols] = useState<Record<string, string[]>>({});
  const [draft, setDraft] = useState<{ parentImportId: string; childKey: string; parentKey: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => api.getLinks(importId).then(setLinks).catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
    api.listImports().then((l) => setImports(l.filter((i) => i.id !== importId))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importId]);

  // Load a candidate parent's columns when picked.
  useEffect(() => {
    const pid = draft?.parentImportId;
    if (!pid || parentCols[pid]) return;
    api.getImport(pid).then((imp) => setParentCols((p) => ({ ...p, [pid]: imp.columns.filter((c) => !('linked' in c && c.linked)).map((c) => c.name) })));
  }, [draft?.parentImportId, parentCols]);

  const act = async (p: Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await p;
      await refresh();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ownNames = ownColumns.map((c) => c.name);
  const startDraft = (parentImportId: string) => {
    const pcols = parentCols[parentImportId] ?? [];
    const childKey = guessKey(ownNames);
    setDraft({ parentImportId, childKey, parentKey: guessKey(pcols, childKey) });
  };
  // Re-guess the parent key once its columns arrive.
  useEffect(() => {
    if (!draft) return;
    const pcols = parentCols[draft.parentImportId];
    if (pcols && !pcols.includes(draft.parentKey)) setDraft({ ...draft, parentKey: guessKey(pcols, draft.childKey) });
  }, [parentCols, draft]);

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="max-h-[85vh] w-[40rem] overflow-auto rounded-lg bg-white p-4 text-xs shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          <div className="text-sm font-semibold">Links for {importName}</div>
          <div className="flex-1" />
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        {error && <div className="mb-2 rounded bg-rose-50 px-2 py-1 text-rose-700">{error}</div>}

        {/* -- Parent ---------------------------------------------------- */}
        <section className="mb-4 space-y-2">
          <div className="font-semibold text-slate-600">Parent</div>
          {links?.parent && !draft ? (
            <ParentLinkEditor link={links.parent} onChange={(body) => act(api.updateLink(links.parent!.id, body))} onRemove={() => act(api.deleteLink(links.parent!.id))} onRekey={() => startDraft(links.parent!.parentImportId)} />
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
              <p className="mb-2 text-slate-500">
                Make <strong>{importName}</strong> a child of another import. Its rows will gain the parent's fields (matched on the key), and the parent's rows will gain roll-ups of these
                rows.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select className="select" value={draft?.parentImportId ?? ''} onChange={(e) => (e.target.value ? startDraft(e.target.value) : setDraft(null))}>
                  <option value="">— choose the parent import —</option>
                  {imports.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
                {draft && (
                  <>
                    <span className="text-slate-500">where</span>
                    <select className="select" value={draft.childKey} onChange={(e) => setDraft({ ...draft, childKey: e.target.value })} title={`Key column in ${importName}`}>
                      {ownNames.map((c) => (
                        <option key={c} value={c}>
                          {importName}: {c}
                        </option>
                      ))}
                    </select>
                    <span className="text-slate-500">=</span>
                    <select className="select" value={draft.parentKey} onChange={(e) => setDraft({ ...draft, parentKey: e.target.value })} title="Key column in the parent">
                      {(parentCols[draft.parentImportId] ?? []).map((c) => (
                        <option key={c} value={c}>
                          {imports.find((i) => i.id === draft.parentImportId)?.name}: {c}
                        </option>
                      ))}
                    </select>
                    <button className="btn btn-sm btn-primary" disabled={busy || !draft.childKey || !draft.parentKey} onClick={() => act(api.setParentLink(importId, draft)).then(() => setDraft(null))}>
                      Link
                    </button>
                    <button className="btn btn-sm" onClick={() => setDraft(null)}>
                      Cancel
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </section>

        {/* -- Children -------------------------------------------------- */}
        <section className="space-y-2">
          <div className="font-semibold text-slate-600">
            Children <span className="font-normal text-slate-400">(imports linked to this one as their parent)</span>
          </div>
          {links && links.children.length === 0 && (
            <p className="text-slate-400">None yet. Open the child import and set <strong>{importName}</strong> as its parent.</p>
          )}
          {links?.children.map((l) => (
            <ChildLinkEditor key={l.id} link={l} onChange={(body) => act(api.updateLink(l.id, body))} onRemove={() => act(api.deleteLink(l.id))} />
          ))}
        </section>
      </div>
    </div>
  );
}

// -- Parent side: which parent fields come down onto this child ---------------

function ParentLinkEditor({ link, onChange, onRemove, onRekey }: { link: ImportLink; onChange: (b: { parentFields: string[] }) => void; onRemove: () => void; onRekey: () => void }) {
  const all = link.parentColumns.filter((c) => c !== link.parentKey);
  const selected = link.parentFields.length ? link.parentFields : all;
  const toggle = (f: string) => {
    const next = selected.includes(f) ? selected.filter((x) => x !== f) : [...selected, f];
    onChange({ parentFields: next.length === all.length ? [] : next });
  };
  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          Child of <strong>{link.parentName}</strong> where <code>{link.childName}: {link.childKey}</code> = <code>{link.parentName}: {link.parentKey}</code>
        </span>
        <div className="flex-1" />
        <button className="btn btn-sm" onClick={onRekey}>
          Change
        </button>
        <button className="btn btn-sm text-rose-600" onClick={onRemove}>
          Unlink
        </button>
      </div>
      <div className="mt-2 text-slate-500">
        Parent fields shown on this import as <code>{link.parentName}: …</code> (click to toggle):
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {all.map((f) => (
          <button
            key={f}
            onClick={() => toggle(f)}
            className={`rounded-full border px-2 py-0.5 ${selected.includes(f) ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-100'}`}
          >
            {f}
          </button>
        ))}
      </div>
    </div>
  );
}

// -- Child side: which roll-ups of the child land on this parent --------------

function ChildLinkEditor({ link, onChange, onRemove }: { link: ImportLink; onChange: (b: { aggregates: Aggregate[] }) => void; onRemove: () => void }) {
  const [aggs, setAggs] = useState<Aggregate[]>(link.aggregates);
  useEffect(() => setAggs(link.aggregates), [link.aggregates]);
  const dirty = JSON.stringify(aggs) !== JSON.stringify(link.aggregates);
  const set = (i: number, patch: Partial<Aggregate>) => setAggs(aggs.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          <strong>{link.childName}</strong> rows where <code>{link.childName}: {link.childKey}</code> = <code>{link.parentName}: {link.parentKey}</code>
        </span>
        <div className="flex-1" />
        <button className="btn btn-sm text-rose-600" onClick={onRemove}>
          Unlink
        </button>
      </div>
      <div className="mt-2 flex items-center">
        <span className="text-slate-500">
          Roll-ups shown on this import as <code>{link.childName}: …</code>
        </span>
        <div className="flex-1" />
        <button className="btn btn-sm" onClick={() => setAggs([...aggs, { id: newId(), fn: 'sum', field: link.childColumns[0] }])}>
          + Roll-up
        </button>
      </div>
      <div className="mt-1 space-y-1">
        {aggs.map((a, i) => (
          <div key={a.id} className="flex flex-wrap items-center gap-1">
            <select className="select" value={a.fn} onChange={(e) => set(i, { fn: e.target.value as Aggregate['fn'], field: e.target.value === 'count' ? undefined : (a.field ?? link.childColumns[0]) })}>
              {AGG_FNS.map((fn) => (
                <option key={fn} value={fn}>
                  {AGG_LABELS[fn]}
                </option>
              ))}
            </select>
            {a.fn !== 'count' && (
              <>
                <span className="text-slate-400">of</span>
                <select className="select" value={a.field ?? ''} onChange={(e) => set(i, { field: e.target.value })}>
                  {link.childColumns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </>
            )}
            <span className="text-slate-400">as</span>
            <input className="input w-36" placeholder={aggregateLabel({ ...a, label: undefined })} value={a.label ?? ''} onChange={(e) => set(i, { label: e.target.value || undefined })} />
            <button className="text-slate-400 hover:text-rose-600" onClick={() => setAggs(aggs.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        {aggs.length === 0 && <div className="text-slate-400">No roll-ups: nothing from {link.childName} appears here.</div>}
      </div>
      {dirty && (
        <div className="mt-2 flex gap-1">
          <button className="btn btn-sm btn-primary" onClick={() => onChange({ aggregates: aggs })}>
            Apply
          </button>
          <button className="btn btn-sm" onClick={() => setAggs(link.aggregates)}>
            Revert
          </button>
        </div>
      )}
    </div>
  );
}

// Keep familyOf referenced for future type-aware roll-up field lists.
void familyOf;
