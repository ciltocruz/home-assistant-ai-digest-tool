import type { IntegrationStatusSummary } from '@ha-digest/shared';

export type IntegrationStatusFailureReason = 'socket_timeout' | 'auth_required_missing' | 'auth_failed' | 'command_rejected' | 'invalid_result' | 'connection_failed';
export type IntegrationStatusSnapshot = IntegrationStatusSummary;
