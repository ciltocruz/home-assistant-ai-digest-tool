import type { DeliveryResult, NotifierChannel, TestResult } from '@ha-digest/shared';
import type { RenderedDigest } from './renderers.js';

export type ResolvedTargetConfig = {
  channel: NotifierChannel;
  label: string;
  config: Record<string, string>;
};

export interface Notifier {
  readonly channel: NotifierChannel;
  test(target: ResolvedTargetConfig): Promise<TestResult>;
  send(digest: RenderedDigest, target: ResolvedTargetConfig): Promise<DeliveryResult>;
}
