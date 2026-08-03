export type IntegrationStatus = { domain: string; title: string; state: string };
export type IntegrationStatusSnapshot = { available: boolean; integrations: IntegrationStatus[] };
