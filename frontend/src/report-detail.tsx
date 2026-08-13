import { useState, type ReactNode } from 'react';
import type { DigestDetail, ReportPresentationItem } from '@ha-digest/shared';
import { currentLocale, t } from './i18n/index.js';
import { redactSensitiveText } from './api-client.js';
import { ConfirmDialog, LiveFeedback } from './feedback.js';

export function ReportDetail({ report, embedded = false, onDelete }: { report: DigestDetail; embedded?: boolean; onDelete?: () => Promise<void> }) {
  const presentation = report.presentation;
  const SectionHeading = embedded ? 'h3' : 'h2';
  const legacyMarkdown = presentation?.mode === 'legacy_markdown' ? presentation.legacyMarkdown : report.rendered.body;
  const source = report.source ?? report.summary.source ?? (presentation?.mode === 'batch' ? 'v2' : 'legacy');
  const [deleteState, setDeleteState] = useState<'idle' | 'confirming' | 'pending' | 'error'>('idle');

  async function deleteReport() {
    if (!onDelete || deleteState === 'pending') return;
    setDeleteState('pending');
    try {
      await onDelete();
    } catch {
      setDeleteState('error');
    }
  }

  return <article className="panel report-detail">
    <p className="eyebrow">{t('report.eyebrow')}</p>
    {embedded ? <h2>{t('report.title')}</h2> : <h1>{t('report.title')}</h1>}
    <p className="muted-copy">{t('report.createdAt').replace('{time}', formatDateTime(report.summary.createdAt))}</p>
    <dl className="report-metadata">
      <div className="report-metadata-id"><dt>{t('report.id')}</dt><dd><code translate="no" dir="ltr">{report.id}</code></dd></div>
      {source === 'v2'
        ? <div><dt>{t('report.generatedAtLabel')}</dt><dd>{formatDateTime(report.summary.createdAt)}</dd></div>
        : <div><dt>{t('report.window')}</dt><dd>{formatDateTime(report.summary.window.from)} — {formatDateTime(report.summary.window.to)}<span className="report-metadata-help">{t('report.windowHelp')}</span></dd></div>}
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
    {presentation?.mode === 'batch' ? <BatchPresentation heading={SectionHeading} presentation={presentation} /> : presentation?.mode === 'structured' ? <>
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
    <footer className="report-actions">
      <a className="report-link" href="/reports">{t('report.back')}</a>
      {onDelete ? <button type="button" className="danger-action" onClick={() => setDeleteState('confirming')}>{t('report.delete.action')}</button> : null}
    </footer>
    <LiveFeedback message={deleteState === 'error' ? t('report.delete.error') : ''} error />
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

function BatchPresentation({ heading: Heading, presentation }: { heading: 'h2' | 'h3'; presentation: Extract<NonNullable<DigestDetail['presentation']>, { mode: 'batch' }> }) {
  if (presentation.status === 'failed') return <section className="report-section" role="alert"><Heading>{t('report.batch.failure')}</Heading><p>{failureLabel(presentation.failure)}</p></section>;
  return <>
    {presentation.warnings.length > 0 ? <section className="report-section report-analysis-note"><Heading>{t('report.batch.warnings')}</Heading><ul>{presentation.warnings.map((warning) => <li key={warning}>{warningLabel(warning)}{warning === 'AI_ANALYSIS_PARTIAL' ? null : <code translate="no" dir="ltr">{warning}</code>}</li>)}</ul></section> : null}
    <section className="report-section"><Heading>{t('report.batch.integrations')}</Heading><p>{presentation.integrationStatus?.available ? presentation.integrationStatus.integrations.map((item) => item.state ? `${item.title ?? item.domain} (${item.state})` : item.title ?? item.domain).join(', ') || t('report.batch.none') : integrationFailureCopy(presentation.integrationStatus?.reason)}</p>{!presentation.integrationStatus?.available ? <p className="muted-copy">{t('report.batch.integrationAction')}</p> : null}</section>
    <section className="report-section report-problems"><Heading>{t('report.batch.problems')}</Heading><p className="report-section-intro">{t('report.batch.groupingExplanation')}</p><ul className="report-presentation-list">{presentation.signatures.map((item) => <li key={item.signature} className="report-presentation-item">
      <div className="report-problem-heading"><p className="report-item-title">{item.problemKind ? t(`report.batch.problemKinds.${item.problemKind}.title`) : t(`report.batch.classification.${item.classification}`)}</p><span className={`severity-badge severity-badge--${severityForLevel(item.level)}`}>{severityLabel(severityForLevel(item.level))}</span></div>
      <p className="report-problem-stats"><span>{item.occurrences === 1 ? t('report.batch.occurrencesSingular') : t('report.batch.occurrencesPlural').replace('{count}', String(item.occurrences))}</span></p>
      {item.problemKind ? <div className="report-ai-content"><div><p className="report-field-label">{t('report.batch.connectionExplanation')}</p><p>{t(`report.batch.problemKinds.${item.problemKind}.copy`)}</p></div><div><p className="report-field-label">{t('report.batch.nextStep')}</p><p>{t(`report.batch.problemKinds.${item.problemKind}.action`)}</p></div></div> : item.analysis ? <div className="report-ai-content"><div><p className="report-field-label">{t('report.batch.aiExplanation')}</p><p>{item.analysis.summary}</p></div><div><p className="report-field-label">{t('report.batch.aiRecommendation')}</p><p>{item.analysis.recommendation}</p></div></div> : <p className="muted-copy">{t('report.batch.analysisUnavailable')}</p>}
      <details className="report-technical-detail"><summary>{t('report.batch.component')}: <span translate="no">{item.component}</span></summary><dl><div><dt>{t('report.batch.technicalId')}</dt><dd><code translate="no" dir="ltr">{item.signature}</code></dd></div></dl></details>
      {item.notes?.length ? <div className="report-operator-notes"><p className="report-field-label">{t('report.batch.operatorNotes')}</p><ul>{item.notes.map((note) => <li key={note.id}>{note.text}</li>)}</ul></div> : null}
    </li>)}</ul></section>
  </>;
}

function severityLabel(severity: NonNullable<ReportPresentationItem['severity']>): string {
  if (severity === 'critical') return t('report.presentation.severity.critical');
  if (severity === 'warning') return t('report.presentation.severity.warning');
  return t('report.presentation.severity.info');
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(currentLocale() === 'es' ? 'es-ES' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value));
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

function integrationFailureCopy(reason?: NonNullable<Extract<NonNullable<DigestDetail['presentation']>, { mode: 'batch' }>['integrationStatus']>['reason']): string {
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
