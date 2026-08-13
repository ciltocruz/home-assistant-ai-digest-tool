import type { SecretStore } from '../../domain/stores.js';
import type { IntegrationStatus, IntegrationStatusFailureReason, IntegrationStatusSnapshot } from '../../application/integration-status.js';

export type { IntegrationStatus, IntegrationStatusSnapshot } from '../../application/integration-status.js';

export type HomeAssistantSocket = {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
};

export type HomeAssistantWebSocketClientOptions = {
  haUrl: string;
  haTokenRef: string;
  secrets: Pick<SecretStore, 'resolve'>;
  webSocketFactory?: (url: string) => HomeAssistantSocket;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export class HomeAssistantWebSocketClient {
  private readonly factory: (url: string) => HomeAssistantSocket;
  private readonly timeoutMs: number;

  constructor(private readonly options: HomeAssistantWebSocketClientOptions) {
    this.factory = options.webSocketFactory ?? ((url) => new WebSocket(url) as unknown as HomeAssistantSocket);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async snapshot(): Promise<IntegrationStatusSnapshot> {
    let socket: HomeAssistantSocket | undefined;
    try {
      const token = await this.options.secrets.resolve(this.options.haTokenRef);
      socket = this.factory(webSocketUrl(this.options.haUrl));
      await waitForOpen(socket, this.timeoutMs);
      const initial = await nextMessage(socket, this.timeoutMs);
      if (initial.type !== 'auth_required') throw reasonError('auth_required_missing');
      socket.send(JSON.stringify({ type: 'auth', access_token: token }));
      const authentication = await nextMessage(socket, this.timeoutMs);
      if (authentication.type !== 'auth_ok') throw reasonError('auth_failed');

      socket.send(JSON.stringify({ id: 1, type: 'config_entries/get' }));
      const result = await nextMessage(socket, this.timeoutMs);
      if (result.id === 1 && result.type === 'result' && result.success === false) throw reasonError('command_rejected');
      if (result.id !== 1 || result.type !== 'result' || result.success !== true || !Array.isArray(result.result)) throw reasonError('invalid_result');
      return { available: true, integrations: result.result.flatMap(toIntegrationStatus) };
    } catch (error) {
      return { available: false, integrations: [], reason: failureReason(error) };
    } finally {
      socket?.close();
    }
  }
}

function webSocketUrl(haUrl: string): string {
  const url = new URL('/api/websocket', haUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function waitForOpen(socket: HomeAssistantSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(reasonError('socket_timeout')), timeoutMs);
    socket.onopen = () => { clearTimeout(timeout); resolve(); };
    socket.onerror = socket.onclose = () => { clearTimeout(timeout); reject(reasonError('connection_failed')); };
  });
}

function nextMessage(socket: HomeAssistantSocket, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(reasonError('socket_timeout')), timeoutMs);
    socket.onmessage = ({ data }) => {
      clearTimeout(timeout);
      try {
        const parsed: unknown = JSON.parse(String(data));
        if (!parsed || typeof parsed !== 'object') throw new Error('invalid');
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(reasonError('invalid_result'));
      }
    };
    socket.onerror = socket.onclose = () => { clearTimeout(timeout); reject(reasonError('connection_failed')); };
  });
}

function reasonError(reason: IntegrationStatusFailureReason): Error {
  return new Error(reason);
}

function failureReason(error: unknown): IntegrationStatusFailureReason {
  const reason = error instanceof Error ? error.message : '';
  return reason === 'socket_timeout' || reason === 'auth_required_missing' || reason === 'auth_failed' || reason === 'command_rejected' || reason === 'invalid_result'
    ? reason
    : 'connection_failed';
}

function toIntegrationStatus(value: unknown): IntegrationStatus[] {
  if (!value || typeof value !== 'object') return [];
  const entry = value as Record<string, unknown>;
  if (typeof entry.domain !== 'string' || typeof entry.state !== 'string') return [];
  return [{ domain: entry.domain, title: typeof entry.title === 'string' ? entry.title : entry.domain, state: entry.state }];
}
