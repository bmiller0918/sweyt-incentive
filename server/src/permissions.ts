// "Restrict feature permissions": which API writes a non-admin needs a
// permission for. Reads (GET, and the POST queries that only read) are
// always open to anyone signed in; admins bypass the table.
import type { PermissionKey } from '@commissions/shared';

interface Rule {
  key: PermissionKey;
  methods: string[];
  test: RegExp;
}

const RULES: Rule[] = [
  { key: 'imports', methods: ['POST'], test: /^\/api\/uploads(\/[^/]+\/commit)?$/ },
  { key: 'imports', methods: ['PATCH', 'DELETE'], test: /^\/api\/imports\/[^/]+$/ },
  { key: 'imports', methods: ['PUT'], test: /^\/api\/imports\/[^/]+\/link$/ },
  { key: 'imports', methods: ['PUT', 'DELETE'], test: /^\/api\/links\/[^/]+$/ },
  { key: 'incentives', methods: ['POST', 'PUT', 'DELETE'], test: /^\/api\/criteria-sets(\/[^/]+)?$/ },
  { key: 'incentives', methods: ['POST', 'PUT', 'DELETE'], test: /^\/api\/incentive-programs(\/(?!preview$).*)?$/ },
  { key: 'plans', methods: ['POST', 'PUT', 'DELETE'], test: /^\/api\/(comp-plans|threshold-types|employee-types|type-assignments)(\/.*)?$/ },
  { key: 'employees', methods: ['POST', 'PUT', 'DELETE'], test: /^\/api\/(employees|assignments)(\/.*)?$/ },
  { key: 'runs', methods: ['POST'], test: /^\/api\/commission-runs$/ },
  { key: 'runs', methods: ['DELETE'], test: /^\/api\/commission-runs\/[^/]+$/ },
  { key: 'holds', methods: ['POST'], test: /^\/api\/commission-runs\/[^/]+\/(hold|release|pay)$/ },
  { key: 'holds', methods: ['POST', 'DELETE'], test: /^\/api\/hold-reasons(\/.*)?$/ },
  { key: 'holds', methods: ['POST', 'PUT', 'DELETE'], test: /^\/api\/payout-rules(\/(?!preview$).*)?$/ },
  { key: 'close', methods: ['POST'], test: /^\/api\/accounting\/(close\/[^/]+|periods\/[^/]+\/reopen)$/ },
  { key: 'accounting', methods: ['PUT'], test: /^\/api\/(accounting-settings|accounting-policy)$/ },
  // "preview" endpoints are POST reads and stay open.
  { key: 'accounting', methods: ['POST', 'PUT', 'DELETE'], test: /^\/api\/(amortization-methods|amortization-types)(\/(?!preview$).*)?$/ },
  { key: 'accounting', methods: ['POST', 'PUT', 'DELETE'], test: /^\/api\/accounting\/assets(\/(?!preview$).*)?$/ },
];

/**
 * The permission a request needs, or null when it is open to every signed-in user.
 * `url` is the matched route pattern when the router has one (`/api/accounting/periods/:month/reopen`),
 * else the raw request URL; the raw URL is decoded the way the router decodes it, so a
 * percent-encoded static segment (`%72eopen`) cannot slip past a rule.
 */
export function permissionFor(method: string, url: string): PermissionKey | null {
  const raw = url.split('?')[0];
  let path = raw;
  try {
    path = decodeURI(raw);
  } catch {
    /* malformed escape: match the raw path */
  }
  const m = method.toUpperCase();
  for (const r of RULES) if (r.methods.includes(m) && r.test.test(path)) return r.key;
  return null;
}
