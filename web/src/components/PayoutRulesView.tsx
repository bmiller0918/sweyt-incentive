import {
  ENFORCEMENT_DIRECTIONS,
  ENFORCEMENT_LABELS,
  OPERATORS_BY_FAMILY,
  OPERATOR_LABELS,
  PRESETS_NEEDING_N,
  RELATIVE_LABELS,
  RELATIVE_PRESETS,
  familyOf,
  operandArity,
  payoutRuleLabel,
  payoutRuleMessage,
  type ColumnFamily,
  type Condition,
  type EnforcementDirection,
  type Operand,
  type Operator,
  type PayoutRule,
  type RelativePreset,
  type Requirement,
} from '@commissions/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type HoldReason, type ImportSummary, type PayoutRuleRow, type PayoutRulesPreview, type RuleField } from '../api';

/**
 * Payout Rules, shaped like a cross-validation rule: each rule has filters
 * (which deals it applies to), requirements (what must or cannot be true of
 * them) and an action (the hold reason and message). Every commission run
 * applies the rules; a deal that breaks one starts on hold. The page opens on
 * the register (every rule in place, plus the hold reasons they pick from);
 * drilling into a rule opens its record. The page also dry-runs the rules
 * against any import so flagged deals can be reviewed.
 */
export function PayoutRulesView() {
  const [view, setView] = useState<'register' | 'record'>('register');
  const [rules, setRules] = useState<PayoutRuleRow[]>([]);
  const [fields, setFields] = useState<RuleField[]>([]);
  const [reasons, setReasons] = useState<HoldReason[]>([]);
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PayoutRule | null>(null);
  const [testImportId, setTestImportId] = useState('');
  const [preview, setPreview] = useState<PayoutRulesPreview | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([api.listPayoutRules(), api.listRuleFields(), api.listHoldReasons(), api.listImports()])
      .then(([rs, fs, hr, imps]) => {
        setRules(rs);
        setFields(fs);
        setReasons(hr);
        setImports(imps);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
  }, []);

  const selected = rules.find((r) => r.id === selectedId) ?? null;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(selected ? stripRow(selected) : null);
  const isNew = draft?.id === NEW_ID;

  /** What the test runs: the saved rules, with the draft standing in for its saved version. */
  const effectiveRules = useMemo<PayoutRule[]>(() => {
    const saved = rules.map(stripRow);
    if (!draft) return saved;
    return isNew ? [...saved, draft] : saved.map((r) => (r.id === draft.id ? draft : r));
  }, [rules, draft, isNew]);

  const testSeq = useRef(0);
  const runTest = useCallback(async (importId: string, rs: PayoutRule[]) => {
    if (!importId) {
      setPreview(null);
      return;
    }
    const seq = ++testSeq.current;
    setTesting(true);
    try {
      const res = await api.previewPayoutRules({ importId, rules: rs });
      if (seq === testSeq.current) setPreview(res);
    } catch (e) {
      if (seq === testSeq.current) setError((e as Error).message);
    } finally {
      if (seq === testSeq.current) setTesting(false);
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => runTest(testImportId, effectiveRules), 150);
    return () => clearTimeout(t);
  }, [testImportId, effectiveRules, runTest]);

  const fail = (e: unknown) => setError((e as Error).message);

  const select = (rule: PayoutRuleRow) => {
    if (dirty && !window.confirm('Discard the unsaved changes to this rule?')) return;
    setSelectedId(rule.id);
    setDraft(stripRow(rule));
    setView('record');
  };

  const startNew = () => {
    if (dirty && !window.confirm('Discard the unsaved changes to this rule?')) return;
    setSelectedId(null);
    setDraft({ id: NEW_ID, name: '', message: '', reasonKey: reasons[0]?.key ?? 'other', filters: [], requirements: [], requireAll: true, enabled: true });
    setView('record');
  };

  /** Back to the register, optionally scrolled to the hold reasons. */
  const openRegister = (toReasons = false) => {
    if (dirty && !window.confirm('Discard the unsaved changes to this rule?')) return;
    setSelectedId(null);
    setDraft(null);
    setView('register');
    if (toReasons) setTimeout(() => document.getElementById('hold-reasons')?.scrollIntoView({ behavior: 'smooth' }), 0);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const body = { name: draft.name, message: draft.message, reasonKey: draft.reasonKey, filters: draft.filters, requirements: draft.requirements, requireAll: draft.requireAll, enabled: draft.enabled };
      const saved = isNew ? await api.createPayoutRule(body) : await api.updatePayoutRule(draft.id, body);
      setRules((rs) => (isNew ? [...rs, saved] : rs.map((r) => (r.id === saved.id ? saved : r))));
      setSelectedId(saved.id);
      setDraft(stripRow(saved));
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (selected) setDraft(stripRow(selected));
    else {
      setDraft(null);
      setView('register');
    }
  };

  const remove = async () => {
    if (!selected || !window.confirm(`Delete the rule "${payoutRuleLabel(selected)}"? Lines it already put on hold stay on hold.`)) return;
    try {
      await api.deletePayoutRule(selected.id);
      setRules((rs) => rs.filter((r) => r.id !== selected.id));
      setSelectedId(null);
      setDraft(null);
      setView('register');
    } catch (e) {
      fail(e);
    }
  };

  const move = async (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= rules.length) return;
    const ids = rules.map((r) => r.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    try {
      setRules(await api.reorderPayoutRules(ids));
    } catch (e) {
      fail(e);
    }
  };

  const testImport = imports.find((i) => i.id === testImportId);
  const draftRows = preview && draft ? preview.rows.filter((r) => r.ruleIds.includes(draft.id)) : [];
  const draftCount = preview && draft ? preview.counts[draft.id] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-200 px-6 pt-5 pb-4">
        <div className="text-xs text-slate-400">
          Payouts
          {view === 'record' && (
            <>
              {' › '}
              <button className="underline hover:text-slate-600" onClick={() => openRegister()}>
                Payout Rules
              </button>
            </>
          )}
        </div>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">{view === 'record' && draft ? payoutRuleLabel(draft) : 'Payout Rules'}</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-500">
              Cross-validation rules on the deal data. Each rule says which deals it applies to (<em>filters</em>), what must or cannot be true of them (<em>requirements</em>), and what
              happens when a deal breaks it: it starts <em>on hold</em> with a reason and message on every commission run, for review under Payouts On Hold. Open a rule to see its
              specifics.
            </p>
          </div>
          <button className="btn btn-primary shrink-0" disabled={!fields.length || !reasons.length} onClick={startNew} title={!fields.length ? 'Import a file first so there are fields to check' : undefined}>
            + New rule
          </button>
        </div>
      </div>

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-6 py-2 text-sm text-red-700">
          {error}{' '}
          <button className="underline" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      {loaded && !fields.length && (
        <div className="m-6 rounded-lg border border-dashed border-slate-300 bg-panel p-6 text-sm text-slate-500">
          Import a spreadsheet first. Rules check the columns of your imports, so there are no fields to pick from yet.
        </div>
      )}
      {loaded && view === 'register' && (
        <RuleRegister
          rules={rules}
          reasons={reasons}
          imports={imports}
          preview={preview}
          testing={testing}
          testImportId={testImportId}
          onTestImport={setTestImportId}
          onOpen={select}
          onMove={move}
          onReasonsChange={setReasons}
          onError={fail}
        />
      )}

      {view === 'record' && fields.length > 0 && reasons.length > 0 && (
        <div className="flex min-h-0 flex-1">
          {/* Rule list */}
          <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200">
            <div className="flex-1 overflow-y-auto p-2">
              {rules.map((r, i) => {
                const active = r.id === selectedId;
                const count = preview?.counts[r.id];
                const skipped = preview?.skipped.includes(r.id);
                const err = preview?.errors[r.id];
                return (
                  <div key={r.id} className={`group flex items-start gap-1 rounded-md px-2 py-1.5 ${active ? 'bg-indigo-50' : 'hover:bg-slate-100'}`}>
                    <button className="min-w-0 flex-1 text-left" onClick={() => select(r)}>
                      <div className={`truncate text-sm ${r.enabled ? 'text-slate-800' : 'text-slate-400 line-through'}`}>{payoutRuleLabel(r)}</div>
                      <div className="truncate text-[11px] text-slate-400">
                        {reasons.find((x) => x.key === r.reasonKey)?.name ?? r.reasonKey}
                        {r.filters.length ? ` · ${r.filters.length} filter${r.filters.length === 1 ? '' : 's'}` : ''}
                      </div>
                      {preview && (
                        <div className="mt-0.5 text-[11px]">
                          {err ? (
                            <span className="text-rose-600" title={err}>
                              can't run
                            </span>
                          ) : skipped ? (
                            <span className="text-slate-400">no such column here</span>
                          ) : !r.enabled ? (
                            <span className="text-slate-400">off</span>
                          ) : count === undefined ? (
                            <span className="text-slate-400">incomplete</span>
                          ) : (
                            <span className={count ? 'text-amber-700' : 'text-emerald-700'}>flags {count.toLocaleString()}</span>
                          )}
                        </div>
                      )}
                    </button>
                    <div className="flex flex-col opacity-0 group-hover:opacity-100">
                      <button className="px-1 text-[10px] text-slate-400 hover:text-slate-700 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} title="Move up (rules apply in order)">
                        ▲
                      </button>
                      <button className="px-1 text-[10px] text-slate-400 hover:text-slate-700 disabled:opacity-30" disabled={i === rules.length - 1} onClick={() => move(i, 1)} title="Move down">
                        ▼
                      </button>
                    </div>
                  </div>
                );
              })}
              {isNew && draft && (
                <div className="rounded-md bg-indigo-50 px-2 py-1.5">
                  <div className="truncate text-sm text-slate-800">{payoutRuleLabel(draft)}</div>
                  <div className="text-[11px] text-slate-400">unsaved</div>
                </div>
              )}
              {!rules.length && !isNew && <div className="px-2 py-6 text-center text-xs text-slate-400">No rules yet.</div>}
            </div>
            <div className="border-t border-slate-200 p-3">
              <div className="text-[11px] text-slate-400">Rules apply in this order; the first rule that flags a deal gives its reason.</div>
              <div className="mt-2 flex items-center gap-2 text-xs">
                <span className="text-slate-500">Test against</span>
                <select className="select flex-1" value={testImportId} onChange={(e) => setTestImportId(e.target.value)}>
                  <option value="">— none —</option>
                  {imports.map((imp) => (
                    <option key={imp.id} value={imp.id}>
                      {imp.name}
                    </option>
                  ))}
                </select>
              </div>
              {preview && (
                <div className="mt-1 text-[11px] text-slate-400">
                  {testing ? 'Testing…' : `${preview.flaggedCount.toLocaleString()} of ${preview.total.toLocaleString()} deals flagged by any rule. Nothing is held by a test.`}
                </div>
              )}
            </div>
          </aside>

          {/* Editor */}
          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            {!draft ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-panel p-6 text-sm text-slate-500">
                Select a rule, or add one. Example: require that <strong>Billing must be Upfront</strong>, or that <strong>Amount cannot be greater than 10,000</strong> for deals where Customer
                is a reseller.
              </div>
            ) : (
              <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-3">
                  <input className="input min-w-64 flex-1 text-base font-medium" placeholder={payoutRuleLabel(draft) === 'Untitled rule' ? 'Rule name' : payoutRuleLabel(draft)} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  <label className="flex items-center gap-1.5 text-sm text-slate-600">
                    <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                    Active
                  </label>
                  <div className="flex items-center gap-2">
                    <button className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
                      {saving ? 'Saving…' : isNew ? 'Create rule' : 'Save'}
                    </button>
                    <button className="btn" disabled={!dirty && !isNew} onClick={discard}>
                      Discard
                    </button>
                    {!isNew && (
                      <button className="btn text-rose-600" onClick={remove}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>

                {/* Action */}
                <section className="rounded-lg border border-slate-200 bg-panel">
                  <div className="border-b border-slate-200 bg-slate-100 px-4 py-2 text-sm font-medium">Action</div>
                  <div className="grid gap-4 p-4 md:grid-cols-2">
                    <label className="block text-xs text-slate-500">
                      Hold reason
                      <select className="select mt-1 block w-full" value={draft.reasonKey} onChange={(e) => setDraft({ ...draft, reasonKey: e.target.value })}>
                        {!reasons.some((r) => r.key === draft.reasonKey) && <option value={draft.reasonKey}>{draft.reasonKey} (removed)</option>}
                        {reasons.map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-[11px] text-slate-400">
                        Flagged deals go on hold with this reason.{' '}
                        <button className="underline" onClick={() => openRegister(true)}>
                          Manage reasons
                        </button>
                      </span>
                    </label>
                    <label className="block text-xs text-slate-500">
                      Hold message
                      <input className="input mt-1 block w-full" placeholder={payoutRuleMessage(draft) || 'e.g. Cannot be paid because billing is not upfront'} value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })} />
                      <span className="mt-1 block text-[11px] text-slate-400">Shown as the note on the held line. Blank = the requirements in words.</span>
                    </label>
                  </div>
                </section>

                <RuleTabs draft={draft} setDraft={setDraft} fields={fields} />

                {/* Test results for this rule */}
                {preview && testImport && (
                  <section>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">Test: {testImport.name}</span>
                      {preview.errors[draft.id] ? (
                        <span className="rounded bg-rose-100 px-1.5 py-0.5 text-xs text-rose-700">{preview.errors[draft.id]}</span>
                      ) : preview.skipped.includes(draft.id) ? (
                        <span className="text-xs text-slate-400">skipped: this import lacks a column this rule names</span>
                      ) : !draft.enabled ? (
                        <span className="text-xs text-slate-400">rule is off</span>
                      ) : draftCount === undefined ? (
                        <span className="text-xs text-slate-400">add a requirement with a value to test</span>
                      ) : (
                        <span className={`rounded-full px-2 py-0.5 text-xs ${draftCount ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
                          flags {draftCount.toLocaleString()} of {preview.total.toLocaleString()} deals
                        </span>
                      )}
                      {dirty && <span className="text-xs text-slate-400">(testing the unsaved draft)</span>}
                    </div>
                    {draftRows.length > 0 && (
                      <div className="mt-2 overflow-auto rounded-lg border border-slate-200 bg-panel" style={{ maxHeight: '24rem' }}>
                        <table className="min-w-full text-xs">
                          <thead className="sticky top-0 bg-panel text-left text-[11px] uppercase tracking-wide text-slate-400">
                            <tr className="border-b border-slate-200">
                              <th className="px-2 py-1.5">Row</th>
                              {preview.columns.map((c) => (
                                <th key={c.name} className="whitespace-nowrap px-2 py-1.5 font-medium">
                                  {c.name}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200">
                            {draftRows.map((r) => (
                              <tr key={r.index}>
                                <td className="px-2 py-1 text-slate-400">{r.index + 1}</td>
                                {preview.columns.map((c) => (
                                  <td key={c.name} className="max-w-64 truncate whitespace-nowrap px-2 py-1" title={r.data[c.name]}>
                                    {r.data[c.name]}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {draftCount !== undefined && draftCount > draftRows.length && (
                          <div className="border-t border-slate-200 px-2 py-1.5 text-[11px] text-slate-400">Showing {draftRows.length} of {draftCount.toLocaleString()} flagged deals.</div>
                        )}
                      </div>
                    )}
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const NEW_ID = 'new';
const stripRow = ({ sortOrder: _s, updatedAt: _u, ...rule }: PayoutRuleRow): PayoutRule => rule;
const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 8)}`;

// -- Register -----------------------------------------------------------------

/** Every rule in place, in the order they apply, plus the hold reasons they pick from. Click a rule to open its record. */
function RuleRegister({
  rules,
  reasons,
  imports,
  preview,
  testing,
  testImportId,
  onTestImport,
  onOpen,
  onMove,
  onReasonsChange,
  onError,
}: {
  rules: PayoutRuleRow[];
  reasons: HoldReason[];
  imports: ImportSummary[];
  preview: PayoutRulesPreview | null;
  testing: boolean;
  testImportId: string;
  onTestImport: (id: string) => void;
  onOpen: (rule: PayoutRuleRow) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onReasonsChange: (reasons: HoldReason[]) => void;
  onError: (e: unknown) => void;
}) {
  const reasonName = (key: string) => reasons.find((x) => x.key === key)?.name ?? `${key} (removed)`;
  return (
    <div className="min-h-0 flex-1 space-y-8 overflow-y-auto p-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="flex-1 text-base font-semibold">Rules in place</h2>
          <span className="text-xs text-slate-500">Test against</span>
          <select className="select" value={testImportId} onChange={(e) => onTestImport(e.target.value)}>
            <option value="">— none —</option>
            {imports.map((imp) => (
              <option key={imp.id} value={imp.id}>
                {imp.name}
              </option>
            ))}
          </select>
        </div>
        {preview && (
          <div className="text-[11px] text-slate-400">
            {testing ? 'Testing…' : `${preview.flaggedCount.toLocaleString()} of ${preview.total.toLocaleString()} deals flagged by any rule. Nothing is held by a test.`}
          </div>
        )}
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-panel">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-left text-xs font-medium text-slate-600">
              <tr>
                <th className="w-12 px-3 py-2">#</th>
                <th className="px-3 py-2">Rule</th>
                <th className="px-3 py-2">Hold reason</th>
                <th className="px-3 py-2">Filters</th>
                <th className="px-3 py-2">Requirements</th>
                <th className="px-3 py-2">Status</th>
                {preview && <th className="px-3 py-2">Test</th>}
                <th className="px-3 py-2">Updated</th>
                <th className="w-12 px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {rules.map((r, i) => {
                const count = preview?.counts[r.id];
                const err = preview?.errors[r.id];
                return (
                  <tr key={r.id} className="group cursor-pointer hover:bg-slate-50" onClick={() => onOpen(r)}>
                    <td className="px-3 py-2 text-slate-400">{i + 1}</td>
                    <td className={`px-3 py-2 font-medium ${r.enabled ? 'text-slate-800' : 'text-slate-400 line-through'}`}>{payoutRuleLabel(r)}</td>
                    <td className="px-3 py-2">{reasonName(r.reasonKey)}</td>
                    <td className="px-3 py-2 text-slate-500">{r.filters.length || 'All deals'}</td>
                    <td className="px-3 py-2 text-slate-500">{r.requirements.length}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded px-1.5 py-0.5 text-[11px] ${r.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'}`}>{r.enabled ? 'Active' : 'Off'}</span>
                    </td>
                    {preview && (
                      <td className="px-3 py-2 text-xs">
                        {err ? (
                          <span className="text-rose-600" title={err}>
                            can't run
                          </span>
                        ) : preview.skipped.includes(r.id) ? (
                          <span className="text-slate-400">no such column</span>
                        ) : !r.enabled ? (
                          <span className="text-slate-400">off</span>
                        ) : count === undefined ? (
                          <span className="text-slate-400">incomplete</span>
                        ) : (
                          <span className={count ? 'text-amber-700' : 'text-emerald-700'}>flags {count.toLocaleString()}</span>
                        )}
                      </td>
                    )}
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">{r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : '—'}</td>
                    <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                      <div className="flex opacity-0 group-hover:opacity-100">
                        <button className="px-1 text-[10px] text-slate-400 hover:text-slate-700 disabled:opacity-30" disabled={i === 0} onClick={() => onMove(i, -1)} title="Move up (rules apply in order)">
                          ▲
                        </button>
                        <button className="px-1 text-[10px] text-slate-400 hover:text-slate-700 disabled:opacity-30" disabled={i === rules.length - 1} onClick={() => onMove(i, 1)} title="Move down">
                          ▼
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!rules.length && (
                <tr>
                  <td colSpan={preview ? 9 : 8} className="px-3 py-6 text-center text-xs text-slate-400">
                    No rules yet. Add one with + New rule.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="text-[11px] text-slate-400">Rules apply in this order; the first rule that flags a deal gives its reason.</div>
      </section>

      <HoldReasons reasons={reasons} onChange={onReasonsChange} onError={onError} />
    </div>
  );
}

/** The hold reasons rules (and manual holds on a run) pick from. Built-ins can't be removed. */
function HoldReasons({ reasons, onChange, onError }: { reasons: HoldReason[]; onChange: (reasons: HoldReason[]) => void; onError: (e: unknown) => void }) {
  const [name, setName] = useState('');
  const refresh = () => api.listHoldReasons().then(onChange);
  const add = async () => {
    if (!name.trim()) return;
    try {
      await api.createHoldReason(name.trim());
      setName('');
      await refresh();
    } catch (e) {
      onError(e);
    }
  };
  return (
    <section id="hold-reasons" className="max-w-3xl space-y-3">
      <div>
        <h2 className="text-base font-semibold">Hold reasons</h2>
        <p className="text-xs text-slate-500">Why a commission line is on hold. Every rule holds with one of these; built-ins can't be removed.</p>
      </div>
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-panel text-sm">
        {reasons.map((r) => (
          <li key={r.id} className="flex items-center gap-2 px-3 py-2">
            <span className="flex-1">{r.name}</span>
            <span className="font-mono text-[11px] text-slate-400">{r.key}</span>
            {r.builtin ? (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">built-in</span>
            ) : (
              <button className="text-slate-400 hover:text-rose-600" onClick={() => api.deleteHoldReason(r.id).then(refresh).catch(onError)}>
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input className="input flex-1" placeholder="New reason, e.g. Pending legal review" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn btn-primary" disabled={!name.trim()} onClick={add}>
          Add
        </button>
      </div>
    </section>
  );
}

// -- Filters / Requirements tabs ----------------------------------------------

function RuleTabs({ draft, setDraft, fields }: { draft: PayoutRule; setDraft: (r: PayoutRule) => void; fields: RuleField[] }) {
  const [tab, setTab] = useState<'filters' | 'requirements'>(draft.requirements.length || !draft.filters.length ? 'requirements' : 'filters');
  const firstField = fields[0];

  const addFilter = () => {
    if (!firstField) return;
    const fam = familyOf(firstField.type);
    setDraft({ ...draft, filters: [...draft.filters, { type: 'condition', id: uid('f'), field: firstField.name, operator: defaultOperator(fam), values: defaultValues(defaultOperator(fam)) }] });
  };
  const addRequirement = () => {
    if (!firstField) return;
    const fam = familyOf(firstField.type);
    setDraft({
      ...draft,
      requirements: [...draft.requirements, { type: 'condition', id: uid('r'), field: firstField.name, direction: 'must', operator: defaultOperator(fam), values: defaultValues(defaultOperator(fam)) }],
    });
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-panel">
      <div className="flex border-b border-slate-200 text-sm">
        {(['filters', 'requirements'] as const).map((t) => (
          <button key={t} className={`px-4 py-2 font-medium uppercase tracking-wide ${tab === t ? 'border-b-2 border-slate-800 text-slate-900' : 'text-slate-500 hover:text-slate-700'}`} onClick={() => setTab(t)}>
            {t} {t === 'filters' ? (draft.filters.length ? `(${draft.filters.length})` : '') : draft.requirements.length ? `(${draft.requirements.length})` : ''}
          </button>
        ))}
      </div>

      {tab === 'filters' ? (
        <div className="p-4">
          <div className="flex items-center gap-3">
            <button className="btn btn-sm" onClick={addFilter}>
              + New filter
            </button>
            <span className="text-xs text-slate-400">Which deals this rule applies to. All filters must match. No filters = every deal.</span>
          </div>
          <ConditionTable
            rows={draft.filters as Condition[]}
            fields={fields}
            onChange={(rows) => setDraft({ ...draft, filters: rows })}
            empty="No filters: this rule applies to every deal."
          />
        </div>
      ) : (
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm" title="On: a deal is flagged if it breaks any requirement. Off: a deal is flagged only if it breaks every requirement (meeting any one is enough).">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Require all</span>
              <Toggle checked={draft.requireAll} onChange={(v) => setDraft({ ...draft, requireAll: v })} />
            </label>
            <button className="btn btn-sm" onClick={addRequirement}>
              + New requirement
            </button>
            <span className="text-xs text-slate-400">
              Example: <em>Amount</em> · <em>Cannot be</em> · <em>Greater than</em> · <em>10000</em> flags any deal over 10,000.
            </span>
          </div>
          <ConditionTable
            rows={draft.requirements as Requirement[]}
            fields={fields}
            withDirection
            onChange={(rows) => setDraft({ ...draft, requirements: rows })}
            empty="No requirements yet. A rule with no requirement flags nothing."
          />
        </div>
      )}
    </section>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-slate-300'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-slate-900 shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} style={{ background: '#f5f1e8' }} />
    </button>
  );
}

// -- Condition rows -------------------------------------------------------------

/** Word labels for the rule editor, so a row reads "Amount · Cannot be · Greater than · 10000". */
const RULE_OPERATOR_LABELS: Partial<Record<Operator, string>> = {
  is: 'Equal',
  is_not: 'Not equal',
  eq: 'Equal',
  neq: 'Not equal',
  gt: 'Greater than',
  gte: 'Greater than or equal',
  lt: 'Less than',
  lte: 'Less than or equal',
  contains: 'Contains',
  not_contains: 'Does not contain',
  starts_with: 'Starts with',
  ends_with: 'Ends with',
  any_of: 'Any of',
  none_of: 'None of',
  regex: 'Matches regex',
  empty: 'Empty',
  not_empty: 'Not empty',
  between: 'Between',
  not_between: 'Not between',
  on: 'On',
  not_on: 'Not on',
  before: 'Before',
  after: 'After',
  on_or_before: 'On or before',
  on_or_after: 'On or after',
  relative: 'Within',
  not_relative: 'Not within',
  is_true: 'True',
  is_false: 'False',
};
const opLabel = (op: Operator) => RULE_OPERATOR_LABELS[op] ?? OPERATOR_LABELS[op] ?? op;

export function defaultOperator(family: ColumnFamily): Operator {
  return family === 'boolean' ? 'is_true' : family === 'number' ? 'eq' : family === 'date' ? 'on_or_after' : 'is';
}
const lit = (value: string): Operand => ({ kind: 'literal', value });
const litValue = (v: Operand | undefined) => (v?.kind === 'literal' ? v.value : '');
export function defaultValues(op: Operator): Operand[] {
  const a = operandArity(op);
  if (a === 0 || a === 'list') return [];
  if (op === 'relative' || op === 'not_relative') return [{ kind: 'relative', preset: 'next_n_days', n: 90 }];
  return a === 2 ? [lit(''), lit('')] : [lit('')];
}

export function ConditionTable<T extends Condition>({ rows, fields, withDirection, onChange, empty }: { rows: T[]; fields: RuleField[]; withDirection?: boolean; onChange: (rows: T[]) => void; empty: string }) {
  const update = (i: number, patch: Partial<T>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  return (
    <div className="mt-3 overflow-x-auto rounded-md border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-indigo-100 text-left text-xs font-medium text-slate-800">
          <tr>
            <th className="px-3 py-2">Field</th>
            {withDirection && <th className="px-3 py-2">Enforcement direction</th>}
            <th className="px-3 py-2">Operator</th>
            <th className="px-3 py-2">Value</th>
            <th className="w-10 px-2 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {rows.map((row, i) => (
            <ConditionRow key={row.id} row={row} fields={fields} withDirection={withDirection} onChange={(patch) => update(i, patch)} onRemove={() => remove(i)} />
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={withDirection ? 5 : 4} className="px-3 py-6 text-center text-xs text-slate-400">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ConditionRow<T extends Condition>({ row, fields, withDirection, onChange, onRemove }: { row: T; fields: RuleField[]; withDirection?: boolean; onChange: (patch: Partial<T>) => void; onRemove: () => void }) {
  const field = fields.find((f) => f.name === row.field);
  const family: ColumnFamily = field ? familyOf(field.type) : 'text';
  const ops = OPERATORS_BY_FAMILY[family].includes(row.operator) ? OPERATORS_BY_FAMILY[family] : [row.operator, ...OPERATORS_BY_FAMILY[family]];
  const arity = operandArity(row.operator);
  const isRelative = row.operator === 'relative' || row.operator === 'not_relative';
  const inputType = family === 'date' ? 'date' : family === 'number' ? 'number' : 'text';
  const setValues = (values: Operand[]) => onChange({ values } as Partial<T>);
  const direction = (row as unknown as Requirement).direction ?? 'must';

  return (
    <tr>
      <td className="px-2 py-1.5">
        <select
          className="select w-full min-w-40"
          value={row.field}
          onChange={(e) => {
            const f = fields.find((x) => x.name === e.target.value);
            const fam = f ? familyOf(f.type) : 'text';
            const op = OPERATORS_BY_FAMILY[fam].includes(row.operator) ? row.operator : defaultOperator(fam);
            onChange({ field: e.target.value, operator: op, values: op === row.operator ? row.values : defaultValues(op) } as Partial<T>);
          }}
        >
          {!field && <option value={row.field}>{row.field} (not in any import)</option>}
          {fields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
      </td>
      {withDirection && (
        <td className="px-2 py-1.5">
          <select className="select w-full min-w-28" value={direction} onChange={(e) => onChange({ direction: e.target.value as EnforcementDirection } as unknown as Partial<T>)}>
            {ENFORCEMENT_DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {ENFORCEMENT_LABELS[d]}
              </option>
            ))}
          </select>
        </td>
      )}
      <td className="px-2 py-1.5">
        <select
          className="select w-full min-w-36"
          value={row.operator}
          onChange={(e) => {
            const op = e.target.value as Operator;
            onChange({ operator: op, values: operandArity(op) === operandArity(row.operator) && !isRelative && op !== 'relative' && op !== 'not_relative' ? row.values : defaultValues(op) } as Partial<T>);
          }}
        >
          {ops.map((o) => (
            <option key={o} value={o}>
              {opLabel(o)}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1.5">
        {arity === 0 ? (
          <span className="text-xs text-slate-400">—</span>
        ) : isRelative ? (
          <RelativeEditor value={row.values[0]} onChange={(v) => setValues([v])} />
        ) : arity === 2 ? (
          <span className="inline-flex items-center gap-1">
            <input type={inputType} className="input w-32" placeholder="from" value={litValue(row.values[0])} onChange={(e) => setValues([lit(e.target.value), row.values[1] ?? lit('')])} />
            <span className="text-xs text-slate-400">and</span>
            <input type={inputType} className="input w-32" placeholder="to" value={litValue(row.values[1])} onChange={(e) => setValues([row.values[0] ?? lit(''), lit(e.target.value)])} />
          </span>
        ) : arity === 'list' ? (
          <ListInput values={row.values.map(litValue)} onChange={(vals) => setValues(vals.map(lit))} />
        ) : (
          <input type={inputType} className="input w-full min-w-40" placeholder="value" value={litValue(row.values[0])} onChange={(e) => setValues([lit(e.target.value)])} />
        )}
      </td>
      <td className="px-2 py-1.5 text-center">
        <button className="text-slate-400 hover:text-rose-600" onClick={onRemove} title="Remove">
          ✕
        </button>
      </td>
    </tr>
  );
}

/** Comma-separated list, kept as text while typing so a trailing comma doesn't vanish. */
function ListInput({ values, onChange }: { values: string[]; onChange: (vals: string[]) => void }) {
  const [text, setText] = useState(values.join(', '));
  useEffect(() => {
    const parsed = text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.join('\u0000') !== values.join('\u0000')) setText(values.join(', '));
    // Only resync when the stored values change from outside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);
  return (
    <input
      className="input w-full min-w-56"
      placeholder="value, value, value"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}

/** Relative-date operand: "next 90 days", "this fiscal quarter", ... */
function RelativeEditor({ value, onChange }: { value: Operand | undefined; onChange: (v: Operand) => void }) {
  const cur = value?.kind === 'relative' ? value : { kind: 'relative' as const, preset: 'next_n_days' as RelativePreset, n: 90 };
  const needsN = PRESETS_NEEDING_N.has(cur.preset);
  return (
    <span className="inline-flex items-center gap-1">
      <select className="select" value={cur.preset} onChange={(e) => onChange({ kind: 'relative', preset: e.target.value as RelativePreset, n: PRESETS_NEEDING_N.has(e.target.value as RelativePreset) ? (cur.n ?? 90) : undefined })}>
        {RELATIVE_PRESETS.map((p) => (
          <option key={p} value={p}>
            {RELATIVE_LABELS[p]}
          </option>
        ))}
      </select>
      {needsN && <input type="number" min={1} className="input w-20" value={cur.n ?? 90} onChange={(e) => onChange({ kind: 'relative', preset: cur.preset, n: Math.max(1, Number(e.target.value) || 1) })} />}
    </span>
  );
}
