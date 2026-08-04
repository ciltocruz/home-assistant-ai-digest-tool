import type { ReactNode } from 'react';
import type { DigestDetail, ReportPresentationItem } from '@ha-digest/shared';
import { currentLocale, t } from './i18n/index.js';

export function ReportDetail({ report, embedded = false }: { report: DigestDetail; embedded?: boolean }) {
  const presentation = report.presentation;
  const SectionHeading = embedded ? 'h3' : 'h2';
  const legacyMarkdown = presentation?.mode === 'legacy_markdown' ? presentation.legacyMarkdown : report.rendered.body;
  return <article className="panel report-detail">
    <p className="eyebrow">{t('report.eyebrow')}</p>
    {embedded ? <h2>{t('report.title').replace('{id}', report.id)}</h2> : <h1>{t('report.title').replace('{id}', report.id)}</h1>}
    <p className="muted-copy">{t('report.createdAt').replace('{time}', formatDateTime(report.summary.createdAt))}</p>
    <dl className="report-metadata">
      <div><dt>{t('report.window')}</dt><dd>{formatDateTime(report.summary.window.from)} — {formatDateTime(report.summary.window.to)}</dd></div>
      <div><dt>{t('report.delivery')}</dt><dd>{deliveryLabel(report.summary.deliveryStatus)}</dd></div>
    </dl>
    <section className="report-section" aria-labelledby="report-severity-title">
      <SectionHeading id="report-severity-title">{t('report.severity.title')}</SectionHeading>
      <div className="severity-strip" aria-label={t('report.severity.ariaLabel')}>
        <span>{t('report.severity.critical')} {report.summary.severityCounts.critical}</span>
        <span>{t('report.severity.warning')} {report.summary.severityCounts.warning}</span>
        <span>{t('report.severity.info')} {report.summary.severityCounts.info}</span>
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
      <section className="report-content" aria-label={t('report.contentAriaLabel')}>
        {renderLegacyMarkdown(legacyMarkdown)}
      </section>
    </>}
    <a className="report-link" href="/reports">{t('report.back')}</a>
  </article>;
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
  if (presentation.status === 'failed') return <section className="report-section" role="alert"><Heading>{t('report.batch.failure')}</Heading><p>{presentation.failure}</p></section>;
  return <>
    {presentation.warnings.length > 0 ? <section className="report-section" role="alert"><Heading>{t('report.batch.warnings')}</Heading><p>{presentation.warnings.join(', ')}</p></section> : null}
    <section className="report-section"><Heading>{t('report.batch.integrations')}</Heading><p>{presentation.integrationStatus?.available ? presentation.integrationStatus.integrations.map((item) => `${item.title} (${item.state})`).join(', ') || t('report.batch.none') : t('report.batch.unavailable')}</p></section>
    <section className="report-section"><Heading>{t('report.batch.signatures')}</Heading><ul className="report-presentation-list">{presentation.signatures.map((item) => <li key={item.signature} className="report-presentation-item"><p className="report-item-title">{item.component} · {t(`report.batch.classification.${item.classification}`)}</p><p>{t('report.batch.trend').replace('{trend}', item.trend).replace('{count}', String(item.occurrences))}</p>{item.analysis ? <><p>{item.analysis.summary}</p><p><strong>{t('report.batch.recommendation')}</strong> {item.analysis.recommendation}</p></> : <p>{t('report.batch.analysisUnavailable')}</p>}{item.notes?.length ? <><p><strong>{currentLocale() === 'es' ? 'Notas del operador:' : 'Operator notes:'}</strong></p><ul>{item.notes.map((note) => <li key={note.id}>{note.text}</li>)}</ul></> : null}</li>)}</ul></section>
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

function deliveryLabel(status: DigestDetail['summary']['deliveryStatus']): string {
  return t(`dashboard.history.deliveryStatus.${status}`);
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
