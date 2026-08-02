export type AppRoute =
  | { kind: 'dashboard' }
  | { kind: 'setup' }
  | { kind: 'reports' }
  | { kind: 'report'; reportId: string }
  | { kind: 'settings'; section?: string };

export function parseAppRoute(pathname: string, search = ''): AppRoute {
  if (pathname === '/setup') return { kind: 'setup' };
  if (pathname === '/' || pathname === '/dashboard') return { kind: 'dashboard' };
  if (pathname === '/reports') return { kind: 'reports' };

  const report = /^\/reports\/([^/]+)$/.exec(pathname);
  if (report?.[1]) return { kind: 'report', reportId: decodeURIComponent(report[1]) };

  if (pathname === '/settings') {
    const section = new URLSearchParams(search).get('section')?.trim();
    return section ? { kind: 'settings', section } : { kind: 'settings' };
  }

  return { kind: 'dashboard' };
}

export function canonicalPath(route: AppRoute): string {
  if (route.kind === 'setup') return '/setup';
  if (route.kind === 'reports') return '/reports';
  if (route.kind === 'report') return `/reports/${encodeURIComponent(route.reportId)}`;
  if (route.kind === 'settings') return route.section ? `/settings?section=${encodeURIComponent(route.section)}` : '/settings';
  return '/';
}

export function redirectForOnboarding(route: AppRoute, complete: boolean): AppRoute {
  if (!complete) return { kind: 'setup' };
  return route.kind === 'setup' ? { kind: 'dashboard' } : route;
}
