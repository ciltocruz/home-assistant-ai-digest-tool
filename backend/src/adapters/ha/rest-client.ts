import type { SecretStore } from '../../domain/stores.js';
import type { HomeAssistantApiClient, HomeAssistantState } from './home-assistant.js';
import { combineAbortSignals, type ExecutionContext } from '../../domain/execution.js';

export type HomeAssistantRestClientOptions = {
  haUrl: string;
  haTokenRef: string;
  secrets: Pick<SecretStore, 'resolve'>;
  maxStates?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

const DEFAULT_MAX_STATES = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 25_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export class HomeAssistantRestClient implements HomeAssistantApiClient {
  constructor(private readonly options: HomeAssistantRestClientOptions) {}

  async listStates(context?: ExecutionContext): Promise<HomeAssistantState[]> {
    context?.checkpoint();
    const cancellation = combineAbortSignals(context?.signal, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const token = await this.options.secrets.resolve(this.options.haTokenRef);
      context?.checkpoint();
      const response = await (this.options.fetch ?? fetch)(new URL('/api/states', this.options.haUrl), {
        method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: cancellation.signal
      });
      if (!response.ok) throw new Error('HA_STATES_UNAVAILABLE');
      const body = await response.text();
      context?.checkpoint();
      if (Buffer.byteLength(body) > (this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)) throw new Error('HA_STATES_TOO_LARGE');
      const parsed: unknown = JSON.parse(body);
      if (!Array.isArray(parsed) || !parsed.every(isState)) throw new Error('HA_STATES_INVALID');
      return parsed.slice(0, this.options.maxStates ?? DEFAULT_MAX_STATES);
    } catch (error) {
      if (context?.signal.aborted) context.checkpoint();
      if (error instanceof Error && /^HA_STATES_/.test(error.message)) throw error;
      throw new Error('HA_STATES_UNAVAILABLE');
    } finally {
      cancellation.dispose();
    }
  }
}

function isState(value: unknown): value is HomeAssistantState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return typeof state.entity_id === 'string' && typeof state.state === 'string'
    && typeof state.last_changed === 'string' && typeof state.last_updated === 'string'
    && (state.attributes === undefined || (typeof state.attributes === 'object' && state.attributes !== null && !Array.isArray(state.attributes)));
}
