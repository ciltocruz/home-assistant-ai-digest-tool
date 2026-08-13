export type IntegrationStatus = { domain: string; title: string; state: string };
export type IntegrationStatusFailureReason = 'socket_timeout' | 'auth_required_missing' | 'auth_failed' | 'command_rejected' | 'invalid_result' | 'connection_failed';
export type IntegrationStatusSnapshot = { available: boolean; integrations: IntegrationStatus[]; reason?: IntegrationStatusFailureReason };
