export type AppView =
  | 'dashboard'
  | 'evalruns'
  | 'evalrun-detail'
  | 'casesets'
  | 'caseset-detail'
  | 'target-endpoints'
  | 'eval-endpoints'
  | 'prompts'
  | 'leaderboard'
  | 'mcp-servers'
  | 'skills';

export interface RouteLocation {
  view: AppView;
  param?: string;
}

type StaticRoute = { view: AppView; hash: string };

const STATIC_ROUTES: StaticRoute[] = [
  { view: 'dashboard', hash: '#/' },
  { view: 'evalruns', hash: '#/eval-runs' },
  { view: 'casesets', hash: '#/case-sets' },
  { view: 'target-endpoints', hash: '#/config/target-endpoints' },
  { view: 'eval-endpoints', hash: '#/config/eval-endpoints' },
  { view: 'prompts', hash: '#/eval-prompts' },
  { view: 'leaderboard', hash: '#/leaderboard' },
  { view: 'mcp-servers', hash: '#/config/mcp-servers' },
  { view: 'skills', hash: '#/config/skills' },
];

const STATIC_BY_VIEW = new Map(STATIC_ROUTES.map(r => [r.view, r.hash]));
const STATIC_BY_HASH = new Map(STATIC_ROUTES.map(r => [r.hash, r.view]));

function normalizeHash(hash: string): string {
  if (!hash || hash === '#') return '#/';
  return hash.startsWith('#') ? hash : `#${hash}`;
}

function encodeParam(param: string): string {
  return encodeURIComponent(param);
}

function decodeParam(param: string): string {
  return decodeURIComponent(param);
}

export function routeToHash(view: AppView, param?: string): string {
  if (view === 'evalrun-detail') return `#/eval-runs/${encodeParam(param || '')}`;
  if (view === 'caseset-detail') return `#/case-sets/${encodeParam(param || '')}`;
  return STATIC_BY_VIEW.get(view) || '#/';
}

export function parseRouteHash(hash: string): RouteLocation {
  const normalized = normalizeHash(hash);
  const staticView = STATIC_BY_HASH.get(normalized);
  if (staticView) return { view: staticView };

  const evalRunMatch = normalized.match(/^#\/eval-runs\/([^/]+)$/);
  if (evalRunMatch) return { view: 'evalrun-detail', param: decodeParam(evalRunMatch[1]) };

  const caseSetMatch = normalized.match(/^#\/case-sets\/([^/]+)$/);
  if (caseSetMatch) return { view: 'caseset-detail', param: decodeParam(caseSetMatch[1]) };

  return { view: 'dashboard' };
}

export function navKeyOf(view: AppView): AppView {
  if (view === 'evalrun-detail') return 'evalruns';
  if (view === 'caseset-detail') return 'casesets';
  return view;
}

export class HashRouter {
  private currentHash = '';

  constructor(private readonly onRoute: (location: RouteLocation) => void) {}

  start(): void {
    window.addEventListener('hashchange', () => this.handleHashChange());
    if (!window.location.hash) {
      this.navigate('dashboard', undefined, { replace: true });
      return;
    }
    this.handleHashChange(true);
  }

  navigate(view: AppView, param?: string, options: { replace?: boolean } = {}): void {
    const nextHash = routeToHash(view, param);
    if (window.location.hash === nextHash) {
      this.handleHashChange(true);
      return;
    }
    if (options.replace) {
      window.history.replaceState(null, '', nextHash);
      this.handleHashChange(true);
      return;
    }
    window.location.hash = nextHash;
  }

  private handleHashChange(force = false): void {
    const normalized = normalizeHash(window.location.hash);
    if (!force && normalized === this.currentHash) return;
    this.currentHash = normalized;
    this.onRoute(parseRouteHash(normalized));
  }
}
