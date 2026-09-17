/**
 * Thin HTTP client for the Sweipe agent REST surface (`sweipe/v1/agent`) and the two
 * core WordPress endpoints an agent also needs (`wp/v2/settings`, `wp/v2/pages`).
 *
 * Auth is a WordPress Application Password sent as HTTP Basic auth. Nothing is cached.
 */

export interface SweipeConfig {
  siteUrl: string;
  user: string;
  appPassword: string;
  /** Seconds a single import `run` call may spend on the server (1–55). */
  importBudget: number;
}

export class SweipeError extends Error {
  constructor(
    message: string,
    public status: number,
    public code = '',
  ) {
    super(message);
  }
}

export function configFromEnv(env = process.env): SweipeConfig {
  const siteUrl = (env.SWEIPE_SITE_URL || '').replace(/\/+$/, '');
  const user = env.SWEIPE_USER || '';
  const appPassword = env.SWEIPE_APP_PASSWORD || '';
  if (!siteUrl || !user || !appPassword) {
    throw new Error(
      'Set SWEIPE_SITE_URL, SWEIPE_USER and SWEIPE_APP_PASSWORD (an administrator Application Password: WordPress → Users → Profile → Application Passwords).',
    );
  }
  const budget = Number(env.SWEIPE_IMPORT_BUDGET || 25);
  return { siteUrl, user, appPassword, importBudget: Math.max(1, Math.min(55, isFinite(budget) ? budget : 25)) };
}

export class SweipeClient {
  private auth: string;

  constructor(private cfg: SweipeConfig) {
    this.auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.appPassword}`).toString('base64');
  }

  get siteUrl(): string {
    return this.cfg.siteUrl;
  }

  async request<T = any>(method: string, path: string, body?: unknown, timeoutMs = 320_000): Promise<T> {
    const url = `${this.cfg.siteUrl}/wp-json/${path.replace(/^\/+/, '')}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: this.auth,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e: any) {
      throw new SweipeError(`Could not reach ${url}: ${e?.message || e}`, 0);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new SweipeError(`Non-JSON reply from ${url} (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status);
    }
    if (!res.ok) {
      const msg = data?.message || `HTTP ${res.status}`;
      throw new SweipeError(msg, res.status, data?.code || '');
    }
    return data as T;
  }

  private namespace: string | null = null;

  /**
   * The plugin's REST namespace: `sweipe/v1` on Sweipe, `flatmobile/v1` on FlatMobile (the
   * flavour build renames it). Read once from the REST index; SWEIPE_NAMESPACE overrides.
   */
  private async ns(): Promise<string> {
    if (this.namespace) return this.namespace;
    const forced = (process.env.SWEIPE_NAMESPACE || '').replace(/^\/+|\/+$/g, '');
    if (forced) return (this.namespace = forced);
    const index = await this.request<any>('GET', '', undefined, 30_000);
    const names: string[] = Array.isArray(index?.namespaces) ? index.namespaces : [];
    const found = names.find((n) => /^(sweipe|flatmobile)\/v1$/.test(n));
    if (!found) {
      throw new SweipeError(
        'This site has no sweipe/v1 or flatmobile/v1 REST namespace. Is the Sweipe or FlatMobile Companion plugin 1.2.1+ active?',
        404,
      );
    }
    return (this.namespace = found);
  }

  async agent<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const ns = await this.ns();
    return this.request<T>(method, `${ns}/agent/${path.replace(/^\/+/, '')}`, body);
  }

  /** Drive an import to completion: call `run` until the server reports `done`. */
  async runImport(importId: string, onProgress?: (s: any) => void): Promise<any> {
    // A demo is a handful of batches; 40 calls at the default budget is ~17 minutes.
    for (let i = 0; i < 40; i++) {
      const status = await this.agent('POST', `imports/${importId}/run`, { budget: this.cfg.importBudget });
      onProgress?.(status);
      if (status.done) return status;
      if (status.status !== 'importing' && status.status !== 'finalizing') {
        throw new SweipeError(`Import ${importId} stopped in state "${status.status}".`, 500);
      }
    }
    throw new SweipeError(`Import ${importId} did not finish in time; check GET imports/${importId}.`, 504);
  }
}
