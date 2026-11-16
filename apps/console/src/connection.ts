import { createClient } from '@credspan/sdk';
export class Connection {
  readonly client;
  private active = true;
  private key: string;
  private requests = new Map<string, AbortController>();
  constructor(key: string, origin: string) {
    this.key = key;
    this.client = createClient({ baseUrl: origin, auth: () => this.key, redirect: 'error', credentials: origin === 'https://credspan-sandbox.m1ngshum.com' ? 'same-origin' : 'omit', cache: 'no-store' });
  }
  cancel(scope: string) { this.requests.get(scope)?.abort(); this.requests.delete(scope); }
  close() { this.active = false; this.key = ''; for (const request of this.requests.values()) request.abort(); this.requests.clear(); this.client.setConfig({ auth: undefined, headers: {} }); }
  async run<T>(scope: string, operation: (signal: AbortSignal) => Promise<{ data?: T; response?: Response }>): Promise<{ kind: 'success'; data: T } | { kind: 'error'; status: number } | { kind: 'stale' }> {
    this.cancel(scope);
    const controller = new AbortController(); this.requests.set(scope, controller);
    const current = () => this.active && this.requests.get(scope) === controller;
    try {
      const result = await operation(controller.signal);
      if (!current()) return { kind: 'stale' };
      if (!result.response?.ok || result.data === undefined) return { kind: 'error', status: result.response?.status ?? 0 };
      return { kind: 'success', data: result.data };
    } catch { return current() ? { kind: 'error', status: 0 } : { kind: 'stale' }; }
    finally { if (this.requests.get(scope) === controller) this.requests.delete(scope); }
  }
}
