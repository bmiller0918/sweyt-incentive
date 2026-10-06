// Header filters are ordinary nodes in the criteria tree, kept at the root
// AND level and identified by id prefix, so the engine, saved sets, impact
// counts and the advanced builder all see them as normal criteria.
//
//   hf:<field>   OR-group of the ticked values ("is any of" + "is empty")
//   hfo:<field>  one operator condition (contains, between, after, ...)
import {
  OPERATOR_LABELS,
  RELATIVE_LABELS,
  familyOf,
  parseBoolean,
  type ColumnDef,
  type Condition,
  type CriteriaNode,
  type Group,
} from '@commissions/shared';

export const valuesId = (field: string) => `hf:${field}`;
export const opId = (field: string) => `hfo:${field}`;

export function isHeaderNode(node: CriteriaNode): boolean {
  return node.id.startsWith('hf:') || node.id.startsWith('hfo:');
}

export interface HeaderFilterState {
  /** Ticked values (raw text, '' = blank), or null when no value filter is set. */
  selected: string[] | null;
  /** The operator condition, if any. */
  op: Condition | null;
}

export function readHeaderFilter(root: Group, field: string): HeaderFilterState {
  const v = root.children.find((c) => c.id === valuesId(field));
  const o = root.children.find((c) => c.id === opId(field));
  let selected: string[] | null = null;
  if (v && v.type === 'group') {
    selected = [];
    for (const c of v.children) {
      if (c.type !== 'condition') continue;
      if (c.operator === 'empty') selected.push('');
      else if (c.operator === 'is_true') selected.push('true');
      else if (c.operator === 'is_false') selected.push('false');
      else for (const val of c.values) if (val.kind === 'literal') selected.push(val.value);
    }
  }
  return { selected, op: o && o.type === 'condition' ? o : null };
}

/** Build the OR-group for a set of ticked values, or null if nothing is ticked. */
export function buildValuesNode(col: ColumnDef, selected: string[]): Group | null {
  const family = familyOf(col.type);
  const blanks = selected.includes('');
  const vals = selected.filter((s) => s !== '');
  const children: Condition[] = [];
  const base = (suffix: string, operator: Condition['operator'], values: Condition['values'] = []): Condition => ({
    type: 'condition',
    id: `${valuesId(col.name)}:${suffix}`,
    field: col.name,
    operator,
    values,
  });
  if (vals.length) {
    if (family === 'text' || family === 'number') {
      children.push({ ...base('v', 'any_of', vals.map((value) => ({ kind: 'literal', value }))), caseSensitive: true });
    } else if (family === 'date') {
      vals.forEach((value, i) => children.push(base(`v${i}`, 'on', [{ kind: 'literal', value }])));
    } else {
      const t = vals.some((v) => parseBoolean(v) === true || v === 'true');
      const f = vals.some((v) => parseBoolean(v) === false || v === 'false');
      if (t) children.push(base('t', 'is_true'));
      if (f) children.push(base('f', 'is_false'));
    }
  }
  if (blanks) children.push(base('e', 'empty'));
  if (!children.length) return null;
  return { type: 'group', id: valuesId(col.name), conjunction: 'or', children };
}

/** Replace a field's header filter nodes at the root level. */
export function setHeaderFilter(root: Group, col: ColumnDef, state: HeaderFilterState): Group {
  const children = root.children.filter((c) => c.id !== valuesId(col.name) && c.id !== opId(col.name));
  const v = state.selected ? buildValuesNode(col, state.selected) : null;
  if (v) children.push(v);
  if (state.op) children.push({ ...state.op, id: opId(col.name), field: col.name });
  return { ...root, children };
}

/** The tree without one field's header filter (for the value list's counts). */
export function withoutHeaderFilter(root: Group, field: string): Group {
  return { ...root, children: root.children.filter((c) => c.id !== valuesId(field) && c.id !== opId(field)) };
}

export function clearHeaderFilters(root: Group): Group {
  return { ...root, children: root.children.filter((c) => !isHeaderNode(c)) };
}

/** Fields that currently have a header filter, in tree order. */
export function activeHeaderFields(root: Group): string[] {
  const out: string[] = [];
  for (const c of root.children) {
    const m = /^hfo?:(.+)$/.exec(c.id);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Anything the header filters can't express, which means the advanced builder should be visible. */
export function hasAdvancedNodes(root: Group): boolean {
  return root.conjunction !== 'and' || !!root.not || root.children.some((c) => !isHeaderNode(c));
}

function operandText(c: Condition): string {
  return c.values
    .map((v) => {
      if (v.kind === 'literal') return v.value;
      if (v.kind === 'field') return `[${v.field}]`;
      if (v.kind === 'param') return `{{${v.name}}}`;
      return `${RELATIVE_LABELS[v.preset]}${v.n ? ` ${v.n}` : ''}`;
    })
    .join(' – ');
}

/** Short chip text, e.g. "Alice, Bob +2" or "> 10000". */
export function headerFilterLabel(state: HeaderFilterState): string {
  const parts: string[] = [];
  if (state.selected) {
    const shown = state.selected.slice(0, 2).map((s) => (s === '' ? '(blank)' : s));
    const more = state.selected.length - shown.length;
    parts.push(shown.join(', ') + (more > 0 ? ` +${more}` : ''));
  }
  if (state.op) parts.push(`${OPERATOR_LABELS[state.op.operator]} ${operandText(state.op)}`.trim());
  return parts.join(' · ');
}
