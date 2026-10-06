import {
  OPERATORS_BY_FAMILY,
  OPERATOR_LABELS,
  PRESETS_NEEDING_N,
  RELATIVE_LABELS,
  RELATIVE_PRESETS,
  familyOf,
  operandArity,
  type ColumnDef,
  type Condition,
  type CriteriaNode,
  type Group,
  type Operand,
  type Operator,
} from '@commissions/shared';

let seq = 0;
export const newId = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

interface Props {
  root: Group;
  columns: ColumnDef[];
  impact: Record<string, number>;
  errors: Record<string, string>;
  onChange: (root: Group) => void;
}

export function CriteriaBuilder({ root, columns, impact, errors, onChange }: Props) {
  return <GroupEditor node={root} columns={columns} impact={impact} errors={errors} onChange={onChange} depth={0} />;
}

// -- Group -------------------------------------------------------------------

interface GroupProps {
  node: Group;
  columns: ColumnDef[];
  impact: Record<string, number>;
  errors: Record<string, string>;
  onChange: (g: Group) => void;
  onRemove?: () => void;
  depth: number;
}

function GroupEditor({ node, columns, impact, errors, onChange, onRemove, depth }: GroupProps) {
  const update = (patch: Partial<Group>) => onChange({ ...node, ...patch });
  const setChild = (i: number, child: CriteriaNode) =>
    update({ children: node.children.map((c, j) => (j === i ? child : c)) });
  const removeChild = (i: number) => update({ children: node.children.filter((_, j) => j !== i) });

  const addCondition = () => {
    const col = columns[0];
    if (!col) return;
    const cond: Condition = {
      type: 'condition',
      id: newId(),
      field: col.name,
      operator: OPERATORS_BY_FAMILY[familyOf(col.type)][0],
      values: [{ kind: 'literal', value: '' }],
    };
    update({ children: [...node.children, cond] });
  };
  const addGroup = () =>
    update({ children: [...node.children, { type: 'group', id: newId(), conjunction: node.conjunction === 'and' ? 'or' : 'and', children: [] }] });

  const tint = depth % 2 === 0 ? 'bg-white' : 'bg-slate-50';

  return (
    <div className={`rounded-lg border ${node.not ? 'border-rose-300' : 'border-slate-200'} ${tint} p-2`}>
      <div className="mb-2 flex items-center gap-2 text-xs">
        <div className="inline-flex overflow-hidden rounded-md border border-slate-300">
          {(['and', 'or'] as const).map((c) => (
            <button
              key={c}
              onClick={() => update({ conjunction: c })}
              className={`px-2 py-0.5 font-semibold uppercase ${
                node.conjunction === c ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1 text-slate-600">
          <input type="checkbox" checked={!!node.not} onChange={(e) => update({ not: e.target.checked || undefined })} />
          NOT
        </label>
        <span className="text-slate-400">
          {node.children.length === 0 ? 'matches all rows' : `${node.children.length} item${node.children.length === 1 ? '' : 's'}`}
        </span>
        <div className="flex-1" />
        <button className="btn btn-sm" onClick={addCondition}>
          + Condition
        </button>
        <button className="btn btn-sm" onClick={addGroup}>
          + Group
        </button>
        {onRemove && (
          <button className="btn btn-sm text-rose-600" onClick={onRemove} title="Remove group">
            ✕
          </button>
        )}
      </div>
      <div className="space-y-2">
        {node.children.map((child, i) => (
          <div key={child.id} className="flex items-start gap-2">
            <div className="w-10 shrink-0 pt-2 text-right text-[10px] font-semibold uppercase text-slate-400">
              {i === 0 ? '' : node.conjunction}
            </div>
            <div className="min-w-0 flex-1">
              {child.type === 'group' ? (
                <GroupEditor
                  node={child}
                  columns={columns}
                  impact={impact}
                  errors={errors}
                  onChange={(g) => setChild(i, g)}
                  onRemove={() => removeChild(i)}
                  depth={depth + 1}
                />
              ) : (
                <ConditionEditor
                  node={child}
                  columns={columns}
                  impact={impact[child.id]}
                  error={errors[child.id]}
                  onChange={(c) => setChild(i, c)}
                  onRemove={() => removeChild(i)}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// -- Condition ---------------------------------------------------------------

interface CondProps {
  node: Condition;
  columns: ColumnDef[];
  impact?: number;
  error?: string;
  onChange: (c: Condition) => void;
  onRemove: () => void;
}

function ConditionEditor({ node, columns, impact, error, onChange, onRemove }: CondProps) {
  const col = columns.find((c) => c.name === node.field) ?? columns[0];
  const family = familyOf(col.type);
  const operators = OPERATORS_BY_FAMILY[family];
  const arity = operandArity(node.operator);
  const disabled = node.enabled === false;

  const setField = (field: string) => {
    const next = columns.find((c) => c.name === field)!;
    const nextFamily = familyOf(next.type);
    const operator = OPERATORS_BY_FAMILY[nextFamily].includes(node.operator) ? node.operator : OPERATORS_BY_FAMILY[nextFamily][0];
    onChange({ ...node, field, operator, values: defaultValues(operator) });
  };
  const setOperator = (operator: Operator) => {
    onChange({ ...node, operator, values: operandArity(operator) === operandArity(node.operator) ? node.values : defaultValues(operator) });
  };
  const setValue = (i: number, v: Operand) => {
    const values = [...node.values];
    values[i] = v;
    onChange({ ...node, values });
  };

  return (
    <div className={`rounded-md border px-2 py-1.5 ${error ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-white'} ${disabled ? 'opacity-50' : ''}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="checkbox"
          checked={!disabled}
          onChange={(e) => onChange({ ...node, enabled: e.target.checked ? undefined : false })}
          title="Enable / disable"
        />
        <select className="select max-w-[11rem]" value={node.field} onChange={(e) => setField(e.target.value)}>
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <select className="select" value={node.operator} onChange={(e) => setOperator(e.target.value as Operator)}>
          {operators.map((op) => (
            <option key={op} value={op}>
              {OPERATOR_LABELS[op]}
            </option>
          ))}
        </select>

        {arity === 1 && (
          <OperandInput value={node.values[0] ?? { kind: 'literal', value: '' }} onChange={(v) => setValue(0, v)} columns={columns} col={col} isRelative={node.operator === 'relative' || node.operator === 'not_relative'} />
        )}
        {arity === 2 && (
          <>
            <OperandInput value={node.values[0] ?? { kind: 'literal', value: '' }} onChange={(v) => setValue(0, v)} columns={columns} col={col} />
            <span className="text-xs text-slate-400">and</span>
            <OperandInput value={node.values[1] ?? { kind: 'literal', value: '' }} onChange={(v) => setValue(1, v)} columns={columns} col={col} />
          </>
        )}
        {arity === 'list' && (
          <input
            className="input min-w-[12rem] flex-1"
            placeholder="comma-separated values"
            value={node.values.map((v) => (v.kind === 'literal' ? v.value : '')).join(', ')}
            onChange={(e) =>
              onChange({
                ...node,
                values: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((value) => ({ kind: 'literal', value })),
              })
            }
          />
        )}

        {family === 'text' && arity !== 0 && (
          <label className="inline-flex items-center gap-1 text-[11px] text-slate-500" title="Case sensitive">
            <input type="checkbox" checked={!!node.caseSensitive} onChange={(e) => onChange({ ...node, caseSensitive: e.target.checked || undefined })} />
            Aa
          </label>
        )}

        <div className="flex-1" />
        {impact !== undefined && !error && (
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              impact > 0 ? 'bg-amber-100 text-amber-800' : impact < 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'
            }`}
            title={
              impact > 0
                ? `Removes ${impact.toLocaleString()} rows (delete it and they come back)`
                : impact < 0
                  ? `Adds ${(-impact).toLocaleString()} rows (inside an OR group)`
                  : 'No effect on the result right now'
            }
          >
            {impact > 0 ? `−${impact.toLocaleString()}` : impact < 0 ? `+${(-impact).toLocaleString()}` : '±0'}
          </span>
        )}
        <button className="text-slate-400 hover:text-rose-600" onClick={onRemove} title="Remove">
          ✕
        </button>
      </div>
      {error && <div className="mt-1 text-[11px] text-rose-700">{error}</div>}
    </div>
  );
}

function defaultValues(op: Operator): Operand[] {
  const a = operandArity(op);
  if (a === 0) return [];
  if (a === 2) return [{ kind: 'literal', value: '' }, { kind: 'literal', value: '' }];
  if (a === 'list') return [];
  if (op === 'relative' || op === 'not_relative') return [{ kind: 'relative', preset: 'this_quarter' }];
  return [{ kind: 'literal', value: '' }];
}

// -- Operand -----------------------------------------------------------------

interface OperandProps {
  value: Operand;
  onChange: (v: Operand) => void;
  columns: ColumnDef[];
  col: ColumnDef;
  isRelative?: boolean;
}

function OperandInput({ value, onChange, columns, col, isRelative }: OperandProps) {
  if (isRelative) {
    const v = value.kind === 'relative' ? value : { kind: 'relative' as const, preset: 'this_quarter' as const };
    return (
      <>
        <select className="select" value={v.preset} onChange={(e) => onChange({ kind: 'relative', preset: e.target.value as typeof v.preset, n: v.n })}>
          {RELATIVE_PRESETS.map((p) => (
            <option key={p} value={p}>
              {RELATIVE_LABELS[p]}
            </option>
          ))}
        </select>
        {PRESETS_NEEDING_N.has(v.preset) && (
          <input
            type="number"
            min={1}
            className="input w-20"
            value={v.n ?? 7}
            onChange={(e) => onChange({ kind: 'relative', preset: v.preset, n: Math.max(1, Number(e.target.value) || 1) })}
          />
        )}
      </>
    );
  }

  const sameFamily = columns.filter((c) => familyOf(c.type) === familyOf(col.type) && c.name !== col.name);
  const kind = value.kind;
  const family = familyOf(col.type);
  const inputType = family === 'date' ? (col.type === 'datetime' ? 'datetime-local' : 'date') : 'text';

  return (
    <span className="inline-flex items-center gap-1">
      <select
        className="select text-xs"
        value={kind}
        onChange={(e) => {
          const k = e.target.value as Operand['kind'];
          if (k === 'literal') onChange({ kind: 'literal', value: '' });
          else if (k === 'field') onChange({ kind: 'field', field: sameFamily[0]?.name ?? columns[0].name });
          else if (k === 'param') onChange({ kind: 'param', name: 'period_start' });
        }}
        title="Value source"
      >
        <option value="literal">value</option>
        <option value="field">field</option>
        <option value="param">param</option>
      </select>
      {kind === 'literal' && (
        <input
          type={inputType}
          className="input w-40"
          value={value.kind === 'literal' ? value.value : ''}
          placeholder={family === 'number' ? '0' : ''}
          onChange={(e) => onChange({ kind: 'literal', value: e.target.value })}
        />
      )}
      {kind === 'field' && (
        <select className="select" value={value.kind === 'field' ? value.field : ''} onChange={(e) => onChange({ kind: 'field', field: e.target.value })}>
          {(sameFamily.length ? sameFamily : columns).map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      {kind === 'param' && (
        <input
          className="input w-32"
          value={value.kind === 'param' ? value.name : ''}
          placeholder="param name"
          onChange={(e) => onChange({ kind: 'param', name: e.target.value })}
        />
      )}
    </span>
  );
}
