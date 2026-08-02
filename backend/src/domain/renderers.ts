import type { StructuredDigest } from './providers.js';
import type { ExecutionContext } from './execution.js';

export type RenderedDigest = {
  format: 'markdown';
  body: string;
};

export interface ReportRenderer {
  render(digest: StructuredDigest, context: ExecutionContext): Promise<RenderedDigest>;
}
