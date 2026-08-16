import { useState, type ReactNode } from 'react';
import { projectIntegrationStatus, type DigestDetail, type IntegrationStatusSummary, type ReportPresentationItem } from '@ha-digest/shared';
import { t } from './i18n/index.js';
import { redactSensitiveText } from './api-client.js';
import { ConfirmDialog, LiveFeedback } from './feedback.js';
import { formatDateTime } from './date-time.js';

export function ReportDetail({ report, embedded = false, onDelete, onIgnoreProblem, onManualTelegramSend, timeZone }: { report: DigestDetail; embedded?: boolean; onDelete?: () => Promise<void>; onIgnoreProblem?: (signature: string) => Promise<void>; onManualTelegramSend?: () => Promise<void>; timeZone?: string }) {
  const presentation = report.presentation;
  const SectionHeading = embedded ? 'h3' : 'h2';
  const legacyMarkdown = presentation?.mode === 'legacy_markdown' ? presentation.legacyMarkdown : report.rendered.body;
  const source = report.source ?? report.summary.source ?? (presentation?.mode === 'batch' ? 'v2' : 'legacy');
  const sendable = !report.id.startsWith('v2-run:') && !(presentation?.mode === 'batch' && presentation.status === 'failed');
  const [deleteState, setDeleteState] = useState<'idle' | 'confirming' | 'pending' | 'error'>('idle');
  const [telegramState, setTelegramState] = useState<'idle' | 'confirming' | 'pending' | 'error'>('idle');

  async function deleteReport() {
    if (!onDelete || deleteState === 'pending') return;
    setDeleteState('pending');
    try {
      await onDelete();
    } catch {
      setDeleteState('error');
    }
  }

  async function sendTelegram() {
    if (!onManualTelegramSend || telegramState === 'pending') return;
    setTelegramState('pending');
    try { await onManualTelegramSend(); setTelegramState('idle'); }
    catch { setTelegramState('error'); }
  }

  return <article className="panel report-detail">
    <p className="eyebrow">{t('report.eyebrow')}</p>
    {embedded ? <h2>{t('report.title')}</h2> : <h1>{t('report.title')}</h1>}
    <p className="muted-copy">{t('report.createdAt').replace('{time}', formatDateTime(report.summary.createdAt, timeZone))}</p>
    <dl className="report-metadata">
      <div className="report-metadata-id"><dt>{t('report.id')}</dt><dd><code translate="no" dir="ltr">{report.id}</code></dd></div>
      {source === 'v2'
        ? <div><dt>{t('report.generatedAtLabel')}</dt><dd>{formatDateTime(report.summary.createdAt, timeZone)}</dd></div>
        : <div><dt>{t('report.window')}</dt><dd>{formatDateTime(report.summary.window.from, timeZone)} — {formatDateTime(report.summary.window.to, timeZone)}<span className="report-metadata-help">{t('report.windowHelp')}</span></dd></div>}
      {source === 'legacy' ? <div><dt>{t('dashboard.history.fields.format')}</dt><dd>{t('dashboard.history.source.legacy')}</dd></div> : null}
    </dl>
    <ReportOutcomes report={report} source={source} heading={SectionHeading} />
    <section className="report-section" aria-labelledby="report-severity-title">
      <SectionHeading id="report-severity-title">{t('report.severity.title')}</SectionHeading>
      <div className="severity-strip" aria-label={t('report.severity.ariaLabel')}>
        <span className="severity-chip severity-chip--critical">{t('report.severity.critical')} {report.summary.severityCounts.critical}</span>
        <span className="severity-chip severity-chip--warning">{t('report.severity.warning')} {report.summary.severityCounts.warning}</span>
        <span className="severity-chip severity-chip--info">{t('report.severity.info')} {report.summary.severityCounts.info}</span>
      </div>
    </section>
    {presentation?.mode === 'batch' ? <BatchPresentation heading={SectionHeading} presentation={presentation} onIgnoreProblem={onIgnoreProblem} /> : presentation?.mode === 'structured' ? <>
      <section className="report-section" aria-labelledby="report-overview-title">
        <SectionHeading id="report-overview-title">{t('report.presentation.overview.title')}</SectionHeading>
        <p className="report-item-title">{presentation.overview.title}</p>
        <p>{presentation.overview.detail}</p>
      </section>
      <PresentationSection heading={SectionHeading} id="report-attention-title" title={t('report.presentation.attention.title')} items={presentation.attention} />
      <PresentationSection heading={SectionHeading} id="report-observations-title" title={t('report.presentation.observations.title')} items={presentation.observations} />
      {presentation.allGood.length > 0 ? <section className="report-section" aria-labelledby="report-all-good-title">
        <SectionHeading id="report-all-good-title">{t('report.presentation.allGood.title')}</SectionHeading>
        <p>{t('report.allGood.copy')}</p>
      </section> : null}
      <PresentationSection heading={SectionHeading} id="report-recommendations-title" title={t('report.presentation.recommendations.title')} items={presentation.recommendations} />
      <PresentationSection heading={SectionHeading} id="report-evidence-title" title={t('report.presentation.evidence.title')} items={presentation.evidence} />
    </> : <>
      <section className="report-section report-legacy" aria-labelledby="report-legacy-title">
        <SectionHeading id="report-legacy-title">{t('report.presentation.legacy.title')}</SectionHeading>
        <p>{t('report.presentation.legacy.copy')}</p>
      </section>
      <details className="report-legacy-disclosure">
         <summary>{t('report.presentation.legacy.disclosure')}</summary>
         <section className="report-content" aria-label={t('report.contentAriaLabel')}>
           {renderLegacyMarkdown(compactLegacyRedactions(redactSensitiveText(legacyMarkdown)))}
         </section>
      </details>
    </>}
    {sendable && report.manualTelegram ? <ManualTelegramStatus heading={SectionHeading} attempts={report.manualTelegram.attempts} timeZone={timeZone} /> : null}
    <footer className="report-actions">
      <a className="report-link" href="/reports">{t('report.back')}</a>
      <div className="report-action-buttons">
        {sendable && report.manualTelegram?.configured && onManualTelegramSend ? <button type="button" className="secondary-action" disabled={telegramState === 'pending'} onClick={() => setTelegramState('confirming')}>{telegramState === 'pending' ? t('report.telegram.pending') : t('report.telegram.action')}</button> : null}
        {onDelete ? <button type="button" className="danger-action" onClick={() => setDeleteState('confirming')}>{t('report.delete.action')}</button> : null}
      </div>
    </footer>
    <LiveFeedback message={deleteState === 'error' ? t('report.delete.error') : ''} error />
    <LiveFeedback message={telegramState === 'pending' ? t('report.telegram.pending') : telegramState === 'error' ? t('report.telegram.error') : ''} error={telegramState === 'error'} />
    <ConfirmDialog
      open={deleteState === 'confirming' || deleteState === 'pending'}
      title={t('report.delete.title')}
      description={t('report.delete.description')}
      confirmLabel={deleteState === 'pending' ? t('report.delete.pending') : t('report.delete.confirm')}
      cancelLabel={t('report.delete.cancel')}
      destructive
      pending={deleteState === 'pending'}
      onCancel={() => setDeleteState('idle')}
      onConfirm={() => void deleteReport()}
    />
    <ConfirmDialog open={telegramState === 'confirming' || telegramState === 'pending'} title={t('report.telegram.title')} description={t('report.telegram.description')} confirmLabel={telegramState === 'pending' ? t('report.telegram.pending') : t('report.telegram.action')} cancelLabel={t('report.telegram.cancel')} pending={telegramState === 'pending'} onCancel={() => setTelegramState('idle')} onConfirm={() => void sendTelegram()} />
  </article>;
}

function ReportOutcomes({ report, source, heading: Heading }: { report: DigestDetail; source: 'legacy' | 'v2'; heading: 'h2' | 'h3' }) {
  const batch = report.presentation?.mode === 'batch' ? report.presentation : undefined;
  const status = batch?.status ?? report.summary.runStatus;
  const total = batch?.signatures.length ?? 0;
  const analyzed = batch?.signatures.filter((item) => item.analysis).length ?? 0;
  const result = source === 'legacy'
    ? t('report.outcomes.legacy')
    : status === 'failed'
      ? t('report.outcomes.failed')
      : status === 'partial'
        ? t('report.outcomes.partial')
        : t('report.outcomes.generated');
  const analysis = source === 'legacy'
    ? t('report.outcomes.analysisLegacy')
    : status === 'failed'
      ? t('report.outcomes.analysisFailed')
      : status === 'quiet'
        ? t('report.outcomes.analysisQuiet')
        : status === 'partial'
          ? t('report.outcomes.analysisPartial').replace('{analyzed}', String(analyzed)).replace('{total}', String(total)).replace('{missing}', String(Math.max(0, total - analyzed)))
          : t('report.outcomes.analysisComplete').replace('{analyzed}', String(analyzed)).replace('{total}', String(total));
  const delivery = t(`report.outcomes.notification${capitalize(report.summary.deliveryStatus)}`);
  const diagnostic = report.summary.deliveryDiagnostic;

  return <section className="report-section report-outcomes" aria-labelledby="report-outcomes-title">
    <Heading id="report-outcomes-title">{t('report.outcomes.title')}</Heading>
    <dl>
      <div><dt>{t('report.outcomes.reportResult')}</dt><dd>{result}</dd></div>
      <div><dt>{t('report.outcomes.aiAnalysis')}</dt><dd>{analysis}</dd></div>
      <div><dt>{t('report.outcomes.telegramNotification')}</dt><dd>{delivery}{diagnostic ? <><span>{t(`report.outcomes.deliveryDiagnostics.${diagnostic.messageKey}.copy`)}</span><span>{t(`report.outcomes.deliveryDiagnostics.${diagnostic.messageKey}.action`)}</span></> : report.summary.deliveryStatus === 'failed' ? <><span>{t('report.outcomes.notificationFailureCopy')}</span><span>{t('report.outcomes.notificationFailureAction')}</span></> : null}</dd></div>
    </dl>
  </section>;
}

function PresentationSection({ heading: Heading, id, title, items }: { heading: 'h2' | 'h3'; id: string; title: string; items: ReportPresentationItem[] }) {
  if (items.length === 0) return null;
  return <section className="report-section" aria-labelledby={id}>
    <Heading id={id}>{title}</Heading>
    <ul className="report-presentation-list">
      {items.map((item) => <li key={item.id} className="report-presentation-item">
        <div className="report-item-heading">
          <p className="report-item-title">{item.title}</p>
          {item.severity ? <span className={`severity-badge severity-badge--${item.severity}`}>{severityLabel(item.severity)}</span> : null}
        </div>
        <p>{item.detail}</p>
      </li>)}
    </ul>
  </section>;
}

function BatchPresentation({ heading: Heading, presentation, onIgnoreProblem }: { heading: 'h2' | 'h3'; presentation: Extract<NonNullable<DigestDetail['presentation']>, { mode: 'batch' }>; onIgnoreProblem?: (signature: string) => Promise<void> }) {
  if (presentation.status === 'failed') return <section className="report-section" role="alert"><Heading>{t('report.batch.failure')}</Heading><p>{failureLabel(presentation.failure)}</p></section>;
  const integrationStatus = projectIntegrationStatus(presentation.integrationStatus);
  return <>
    {presentation.warnings.length > 0 ? <section className="report-section report-analysis-note"><Heading>{t('report.batch.warnings')}</Heading><ul>{presentation.warnings.map((warning) => <li key={warning}>{warningLabel(warning)}{warning === 'AI_ANALYSIS_PARTIAL' ? null : <code translate="no" dir="ltr">{warning}</code>}</li>)}</ul></section> : null}
    <IntegrationSummary heading={Heading} status={integrationStatus} />
    <section className="report-section report-problems"><Heading>{t('report.batch.problems')}</Heading><p className="report-section-intro">{t('report.batch.groupingExplanation')}</p><ul className="report-presentation-list">{presentation.signatures.map((item) => <ProblemCard key={item.signature} item={item} onIgnoreProblem={onIgnoreProblem} />)}</ul></section>
  </>;
}

function ProblemCard({ item, onIgnoreProblem }: { item: Extract<NonNullable<DigestDetail['presentation']>, { mode: 'batch' }>['signatures'][number]; onIgnoreProblem?: (signature: string) => Promise<void> }) {
  const [ignoreState, setIgnoreState] = useState<'idle' | 'confirming' | 'pending' | 'ignored' | 'error'>(item.ignoredForFuture ? 'ignored' : 'idle');
  async function ignore() {
    if (!onIgnoreProblem || ignoreState === 'pending') return;
    setIgnoreState('pending');
    try { await onIgnoreProblem(item.signature); setIgnoreState('ignored'); }
    catch { setIgnoreState('error'); }
  }
  return <li className="report-presentation-item">
      <div className="report-problem-heading"><p className="report-item-title"><span>{item.problemKind ? t(`report.batch.problemKinds.${item.problemKind}.title`) : t(`report.batch.classification.${item.classification}`)}</span> <code className="report-component-badge" translate="no" dir="ltr">{item.component}</code></p><span className={`severity-badge severity-badge--${severityForLevel(item.level)}`}>{severityLabel(severityForLevel(item.level))}</span></div>
      <p className="report-problem-stats"><span>{item.occurrences === 1 ? t('report.batch.occurrencesSingular') : t('report.batch.occurrencesPlural').replace('{count}', String(item.occurrences))}</span></p>
      {item.problemKind ? <div className="report-ai-content"><div><p className="report-field-label">{t('report.batch.connectionExplanation')}</p><p>{t(`report.batch.problemKinds.${item.problemKind}.copy`)}</p></div><div><p className="report-field-label">{t('report.batch.nextStep')}</p><p>{t(`report.batch.problemKinds.${item.problemKind}.action`)}</p></div></div> : item.analysis ? <div className="report-ai-content"><div><p className="report-field-label">{t('report.batch.aiExplanation')}</p><p>{item.analysis.summary}</p></div><div><p className="report-field-label">{t('report.batch.aiRecommendation')}</p><p>{item.analysis.recommendation}</p></div></div> : <><p className="muted-copy">{t('report.batch.analysisUnavailable')}</p>{item.safeExcerpt ? <details className="report-trace-detail"><summary>{t('report.batch.trace.action')}</summary><p>{t('report.batch.trace.warning')}</p><pre><code dir="ltr" translate="no">{item.safeExcerpt.lines.join('\n')}</code></pre></details> : <p className="muted-copy">{t('report.batch.trace.unavailable')}</p>}</>}
      <details className="report-technical-detail"><summary>{t('report.batch.component')}: <span translate="no">{item.component}</span></summary><dl><div><dt>{t('report.batch.technicalId')}</dt><dd><code translate="no" dir="ltr">{item.signature}</code></dd></div></dl></details>
      {item.notes?.length ? <div className="report-operator-notes"><p className="report-field-label">{t('report.batch.operatorNotes')}</p><ul>{item.notes.map((note) => <li key={note.id}>{note.text}</li>)}</ul></div> : null}
      <div className="report-problem-actions">{ignoreState === 'ignored' ? <span className="report-action-state" role="status">{t('report.ignore.success')}</span> : onIgnoreProblem ? <button type="button" className="secondary-action" disabled={ignoreState === 'pending'} onClick={() => setIgnoreState('confirming')}>{ignoreState === 'pending' ? t('report.ignore.pending') : t('report.ignore.action')}</button> : null}</div>
      <LiveFeedback message={ignoreState === 'error' ? t('report.ignore.error') : ''} error />
      <ConfirmDialog open={ignoreState === 'confirming' || ignoreState === 'pending'} title={t('report.ignore.title')} description={t('report.ignore.description')} confirmLabel={ignoreState === 'pending' ? t('report.ignore.pending') : t('report.ignore.action')} cancelLabel={t('report.ignore.cancel')} pending={ignoreState === 'pending'} onCancel={() => setIgnoreState('idle')} onConfirm={() => void ignore()} />
    </li>;
}

function IntegrationSummary({ heading: Heading, status }: { heading: 'h2' | 'h3'; status?: IntegrationStatusSummary }) {
  if (!status?.available) return <section className="report-section report-integrations"><Heading>{t('report.batch.integrations')}</Heading><p>{integrationFailureCopy(status?.reason)}</p><p className="muted-copy">{t('report.batch.integrationAction')}</p></section>;
  return <section className="report-section report-integrations" aria-labelledby="report-integrations-title">
    <Heading id="report-integrations-title">{t('report.batch.integrations')}</Heading>
    <p className="report-section-intro">{t('report.batch.integrationSummary')}</p>
    <dl className="integration-summary-grid">
      <div><dt>{t('report.batch.integrationChecked')}</dt><dd>{status.total}</dd></div>
      <div><dt>{t('report.batch.integrationLoaded')}</dt><dd>{status.loaded}</dd></div>
      <div><dt>{t('report.batch.integrationNotLoaded')}</dt><dd>{status.notLoaded}</dd></div>
      <div><dt>{t('report.batch.integrationInProgress')}</dt><dd>{status.inProgress}</dd></div>
      <div><dt>{t('report.batch.integrationRetrying')}</dt><dd>{status.retrying}</dd></div>
      <div className={status.errors > 0 ? 'integration-summary-error' : undefined}><dt>{t('report.batch.integrationErrors')}</dt><dd>{status.errors}</dd></div>
      <div><dt>{t('report.batch.integrationUnknown')}</dt><dd>{status.unknown}</dd></div>
    </dl>
    <p className="integration-neutral-note">{t('report.batch.integrationNotLoadedHelp')}</p>
    {status.inProgress > 0 ? <p className="integration-neutral-note">{t('report.batch.integrationInProgressHelp')}</p> : null}
    {status.retrying > 0 ? <p className="integration-neutral-note">{t('report.batch.integrationRetryingHelp')}</p> : null}
    {status.unknown > 0 ? <p className="integration-neutral-note">{t('report.batch.integrationUnknownHelp')}</p> : null}
    {status.errors > 0 ? <p className="integration-attention">{t('report.batch.integrationErrorsHelp')}</p> : <p className="integration-clear">{t('report.batch.integrationClear')}</p>}
    {status.errorGroups?.length ? <div className="integration-error-groups"><p>{t('report.batch.integrationGroupExplanation')}</p><ul>{status.errorGroups.map((group) => <li key={`${group.category}:${group.reason}`}><span>{t(`report.batch.integrationCategories.${group.category}`)}</span><span>{t(`report.batch.integrationErrorReasons.${group.reason}`)}</span><strong>{group.count}</strong></li>)}</ul><p>{t('report.batch.integrationGroupAction')}</p></div> : status.errors > 0 ? <p className="integration-neutral-note">{t('report.batch.integrationGroupsUnavailable')}</p> : null}
  </section>;
}

function ManualTelegramStatus({ heading: Heading, attempts, timeZone }: { heading: 'h2' | 'h3'; attempts: NonNullable<DigestDetail['manualTelegram']>['attempts']; timeZone?: string }) {
  return <section className="report-section report-manual-telegram" aria-labelledby="report-manual-telegram-title"><Heading id="report-manual-telegram-title">{t('report.telegram.statusTitle')}</Heading>{attempts.length === 0 ? <p>{t('report.telegram.none')}</p> : <ul>{attempts.map((attempt) => <li key={attempt.actionId}><span>{formatDateTime(attempt.completedAt ?? attempt.requestedAt, timeZone)}</span><strong>{t(`report.telegram.status.${attempt.status}`)}</strong>{attempt.diagnostic ? <span className="report-manual-telegram-diagnostic">{t(`report.outcomes.deliveryDiagnostics.${attempt.diagnostic.messageKey}.copy`)}</span> : null}</li>)}</ul>}</section>;
}

function severityLabel(severity: NonNullable<ReportPresentationItem['severity']>): string {
  if (severity === 'critical') return t('report.presentation.severity.critical');
  if (severity === 'warning') return t('report.presentation.severity.warning');
  return t('report.presentation.severity.info');
}

function capitalize(value: DigestDetail['summary']['deliveryStatus']): 'Sent' | 'Failed' | 'Pending' | 'Skipped' {
  return `${value[0]?.toUpperCase()}${value.slice(1)}` as 'Sent' | 'Failed' | 'Pending' | 'Skipped';
}

function warningLabel(code: string): string {
  if (code === 'AI_ANALYSIS_PARTIAL') return t('report.batch.warningPartial');
  if (code === 'AI_ANALYSIS_UNAVAILABLE') return t('report.batch.warningUnavailable');
  if (code === 'REPORT_CORRUPT' || code === 'REPORT_PAYLOAD_INVALID' || code === 'REPORT_MISSING') return t('report.batch.warningCorrupt');
  return t('report.batch.warningGeneric');
}

function failureLabel(message?: string): string {
  if (message === 'invalid signature analysis'
    || message === 'OpenAI provider returned an invalid signature analysis'
    || message === 'Gemini provider returned an invalid signature analysis'
    || message === 'Ollama provider returned an invalid signature analysis') {
    return t('report.batch.failureInvalidAnalysis');
  }
  return t('report.batch.failureGeneric');
}

function severityForLevel(level: 'ERROR' | 'CRITICAL' | 'WARNING'): 'critical' | 'warning' {
  return level === 'CRITICAL' ? 'critical' : 'warning';
}

function integrationFailureCopy(reason?: Extract<IntegrationStatusSummary, { available: false }>['reason']): string {
  return reason ? t(`report.batch.integrationReasons.${reason}`) : t('report.batch.unavailable');
}

function renderLegacyMarkdown(markdown: string) {
  const blocks: ReactNode[] = [];
  const lines = markdown.split(/\r?\n/);
  let paragraph: string[] = [];
  let list: string[] = [];

  function flushParagraph() {
    if (paragraph.length > 0) blocks.push(<p key={`paragraph-${blocks.length}`}>{paragraph.join(' ')}</p>);
    paragraph = [];
  }
  function flushList() {
    if (list.length > 0) blocks.push(<ul key={`list-${blocks.length}`}>{list.map((item, index) => <li key={index}>{item}</li>)}</ul>);
    list = [];
  }

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const listItem = /^[-*]\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(heading[1].length === 1 ? <h2 key={`heading-${blocks.length}`}>{heading[2]}</h2> : <h3 key={`heading-${blocks.length}`}>{heading[2]}</h3>);
    } else if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
    } else if (line.trim()) {
      flushList();
      paragraph.push(line.trim());
    } else {
      flushParagraph();
      flushList();
    }
  }
  flushParagraph();
  flushList();
  return blocks.length > 0 ? blocks : <p>{t('report.emptyContent')}</p>;
}

function compactLegacyRedactions(markdown: string): string {
  const placeholder = t('report.presentation.legacy.protectedData');
  const withPlaceholders = markdown.replace(/(?:\[redacted\]|\bredacted\b)/gi, placeholder);
  const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return withPlaceholders.replace(new RegExp(`(?:${escapedPlaceholder})(?:\\s+${escapedPlaceholder})+`, 'g'), placeholder);
}
