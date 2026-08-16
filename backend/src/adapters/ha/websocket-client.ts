import type { SecretStore } from '../../domain/stores.js';
import { projectIntegrationStatus } from '@ha-digest/shared';
import type { IntegrationStatusFailureReason, IntegrationStatusSnapshot } from '../../application/integration-status.js';

export type { IntegrationStatusSnapshot } from '../../application/integration-status.js';

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
      return projectIntegrationStatus({ available: true, integrations: result.result })!;
    } catch (error) {
      return { available: false, reason: failureReason(error) };
    } finally {
      socket?.close();
    }
  }

  async fetchDeviceRegistryMap(): Promise<Map<string, { deviceId?: string; deviceName?: string }>> {
    const map = new Map<string, { deviceId?: string; deviceName?: string }>();
    let socket: HomeAssistantSocket | undefined;
    try {
      const token = await this.options.secrets.resolve(this.options.haTokenRef);
      socket = this.factory(webSocketUrl(this.options.haUrl));
      await waitForOpen(socket, this.timeoutMs);
      const initial = await nextMessage(socket, this.timeoutMs);
      if (initial.type !== 'auth_required') return map;
      socket.send(JSON.stringify({ type: 'auth', access_token: token }));
      const authentication = await nextMessage(socket, this.timeoutMs);
      if (authentication.type !== 'auth_ok') return map;

      socket.send(JSON.stringify({ id: 1, type: 'config/entity_registry/list' }));
      const entityRes = await nextMessage(socket, this.timeoutMs);
      if (entityRes.id !== 1 || entityRes.type !== 'result' || entityRes.success !== true || !Array.isArray(entityRes.result)) return map;

      socket.send(JSON.stringify({ id: 2, type: 'config/device_registry/list' }));
      const deviceRes = await nextMessage(socket, this.timeoutMs);
      if (deviceRes.id !== 2 || deviceRes.type !== 'result' || deviceRes.success !== true || !Array.isArray(deviceRes.result)) return map;

      const deviceNames = new Map<string, string>();
      for (const dev of deviceRes.result) {
        if (!dev || typeof dev !== 'object') continue;
        const d = dev as Record<string, unknown>;
        if (typeof d.id !== 'string') continue;
        const name = (typeof d.name_by_user === 'string' && d.name_by_user.trim())
          || (typeof d.name === 'string' && d.name.trim())
          || (typeof d.model === 'string' && d.model.trim())
          || undefined;
        if (name) deviceNames.set(d.id, name);
      }

      for (const ent of entityRes.result) {
        if (!ent || typeof ent !== 'object') continue;
        const e = ent as Record<string, unknown>;
        if (typeof e.entity_id !== 'string') continue;
        const deviceId = typeof e.device_id === 'string' ? e.device_id : undefined;
        const deviceName = deviceId ? deviceNames.get(deviceId) : undefined;
        if (deviceId || deviceName) {
          map.set(e.entity_id, { ...(deviceId ? { deviceId } : {}), ...(deviceName ? { deviceName } : {}) });
        }
      }
    } catch {
      // Return empty/partial map on socket error
    } finally {
      socket?.close();
    }
    return map;
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
