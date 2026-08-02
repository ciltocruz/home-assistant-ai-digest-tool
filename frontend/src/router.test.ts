import { describe, expect, it } from 'vitest';
import { canonicalPath, parseAppRoute, redirectForOnboarding } from './router.js';

describe('application routes', () => {
  it('parses each operational area and preserves existing settings and report links', () => {
    expect(parseAppRoute('/')).toEqual({ kind: 'dashboard' });
    expect(parseAppRoute('/reports')).toEqual({ kind: 'reports' });
    expect(parseAppRoute('/reports/report-9')).toEqual({ kind: 'report', reportId: 'report-9' });
    expect(parseAppRoute('/settings', '?section=privacy')).toEqual({ kind: 'settings', section: 'privacy' });
  });

  it('uses canonical setup redirects without changing a valid operational deep link', () => {
    const report = parseAppRoute('/reports/report%209');

    expect(redirectForOnboarding(report, false)).toEqual({ kind: 'setup' });
    expect(redirectForOnboarding({ kind: 'setup' }, true)).toEqual({ kind: 'dashboard' });
    expect(canonicalPath(report)).toBe('/reports/report%209');
  });
});
