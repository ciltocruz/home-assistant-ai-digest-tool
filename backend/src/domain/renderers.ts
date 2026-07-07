import type { StructuredDigest } from './providers.js';

export type RenderedDigest = {
  format: 'markdown';
  body: string;
};

export interface ReportRenderer {
  render(digest: StructuredDigest): Promise<RenderedDigest>;
}
