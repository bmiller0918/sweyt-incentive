import { describe, expect, it } from 'vitest';
import { permissionFor } from './permissions.js';

describe('permissionFor', () => {
  it('leaves reads open', () => {
    expect(permissionFor('GET', '/api/imports')).toBeNull();
    expect(permissionFor('GET', '/api/commission-runs/abc')).toBeNull();
    expect(permissionFor('GET', '/api/accounting/register.csv?month=2026-01')).toBeNull();
    expect(permissionFor('GET', '/api/users')).toBeNull();
  });

  it('leaves the POST endpoints that only read open', () => {
    expect(permissionFor('POST', '/api/imports/abc/query')).toBeNull();
    expect(permissionFor('POST', '/api/imports/abc/values')).toBeNull();
    expect(permissionFor('POST', '/api/imports/abc/group-rows')).toBeNull();
    expect(permissionFor('POST', '/api/imports/abc/explain')).toBeNull();
    expect(permissionFor('POST', '/api/imports/abc/export')).toBeNull();
    expect(permissionFor('POST', '/api/amortization-methods/preview')).toBeNull();
    expect(permissionFor('POST', '/api/accounting/assets/preview')).toBeNull();
    expect(permissionFor('POST', '/api/payout-rules/preview')).toBeNull();
  });

  it('maps writes to their permission', () => {
    expect(permissionFor('POST', '/api/uploads')).toBe('imports');
    expect(permissionFor('POST', '/api/uploads/u1/commit')).toBe('imports');
    expect(permissionFor('PATCH', '/api/imports/abc')).toBe('imports');
    expect(permissionFor('DELETE', '/api/imports/abc')).toBe('imports');
    expect(permissionFor('PUT', '/api/imports/abc/link')).toBe('imports');
    expect(permissionFor('DELETE', '/api/links/l1')).toBe('imports');
    expect(permissionFor('POST', '/api/criteria-sets')).toBe('incentives');
    expect(permissionFor('PUT', '/api/criteria-sets/c1')).toBe('incentives');
    expect(permissionFor('POST', '/api/comp-plans')).toBe('plans');
    expect(permissionFor('DELETE', '/api/threshold-types/t1')).toBe('plans');
    expect(permissionFor('POST', '/api/employee-types/t1/assignments')).toBe('plans');
    expect(permissionFor('PUT', '/api/type-assignments/a1')).toBe('plans');
    expect(permissionFor('POST', '/api/employees/bulk')).toBe('employees');
    expect(permissionFor('DELETE', '/api/assignments/a1')).toBe('employees');
    expect(permissionFor('POST', '/api/commission-runs')).toBe('runs');
    expect(permissionFor('DELETE', '/api/commission-runs/r1')).toBe('runs');
    expect(permissionFor('POST', '/api/commission-runs/r1/hold')).toBe('holds');
    expect(permissionFor('POST', '/api/commission-runs/r1/release')).toBe('holds');
    expect(permissionFor('POST', '/api/commission-runs/r1/pay')).toBe('holds');
    expect(permissionFor('POST', '/api/hold-reasons')).toBe('holds');
    expect(permissionFor('POST', '/api/payout-rules')).toBe('holds');
    expect(permissionFor('PUT', '/api/payout-rules/order')).toBe('holds');
    expect(permissionFor('DELETE', '/api/payout-rules/r1')).toBe('holds');
    expect(permissionFor('POST', '/api/accounting/close/2026-01')).toBe('close');
    expect(permissionFor('POST', '/api/accounting/periods/2026-01/reopen')).toBe('close');
    expect(permissionFor('PUT', '/api/accounting-settings')).toBe('accounting');
    expect(permissionFor('PUT', '/api/accounting-policy')).toBe('accounting');
    expect(permissionFor('POST', '/api/amortization-methods')).toBe('accounting');
    expect(permissionFor('POST', '/api/amortization-types/assign')).toBe('accounting');
    expect(permissionFor('POST', '/api/accounting/assets')).toBe('accounting');
    expect(permissionFor('POST', '/api/accounting/assets/a1/write-off')).toBe('accounting');
    expect(permissionFor('DELETE', '/api/accounting/assets/a1')).toBe('accounting');
  });

  it('ignores the query string and method case', () => {
    expect(permissionFor('post', '/api/commission-runs?x=1')).toBe('runs');
  });

  it('sees through percent-encoding, as the router does', () => {
    expect(permissionFor('POST', '/api/accounting/periods/2026-01/%72eopen')).toBe('close');
    expect(permissionFor('POST', '/api/commission-runs/r1/%68old')).toBe('holds');
    expect(permissionFor('DELETE', '/api/%69mports/abc')).toBe('imports');
    expect(permissionFor('POST', '/api/accounting/periods/2026-01/%ZZreopen')).toBeNull();
  });

  it('accepts the matched route pattern', () => {
    expect(permissionFor('POST', '/api/accounting/periods/:month/reopen')).toBe('close');
    expect(permissionFor('POST', '/api/commission-runs/:id/hold')).toBe('holds');
    expect(permissionFor('POST', '/api/uploads/:id/commit')).toBe('imports');
    expect(permissionFor('PUT', '/api/accounting/assets/:id')).toBe('accounting');
    expect(permissionFor('POST', '/api/accounting/assets/preview')).toBeNull();
    expect(permissionFor('POST', '/api/imports/:id/query')).toBeNull();
  });
});
