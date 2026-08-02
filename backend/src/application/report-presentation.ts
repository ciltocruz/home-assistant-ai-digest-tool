import type { DigestDetail, ReportPresentationItem, ReportPresentationV1 } from '@ha-digest/shared';

type ReportSource = Pick<DigestDetail, 'id' | 'summary' | 'rendered'>;
type StructuredSection = 'attention' | 'observations' | 'recommendations' | 'evidence';

const SECTION_HEADINGS: Record<string, StructuredSection> = {
  'attention items': 'attention',
  observations: 'observations',
  recommendations: 'recommendations',
  evidence: 'evidence'
};
const ITEM_PATTERN = /^- \*\*(.+?)\*\*(?:\s+\((critical|warning|info)\))?:\s+(.+)$/;

export function projectReportPresentation(report: ReportSource): ReportPresentationV1 {
  const parsed = parseCanonicalMarkdown(report.rendered.body);
  if (!parsed) return { version: 1, mode: 'legacy_markdown', legacyMarkdown: report.rendered.body };

  const attention = parsed.attention
    .filter((item) => item.severity === 'critical' || item.severity === 'warning')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const observations = parsed.observations.filter((item) => item.severity === 'info');
  const allGood = hasActionableIncidents(report)
    ? []
    : [{ id: 'all-good-1', title: 'No actionable incidents', detail: 'No critical or warning incidents were recorded for this report.' }];
  const recommendations = attention.length > 0
    ? [{ ...attention[0], id: 'recommendation-1' }]
    : parsed.recommendations;

  return {
    version: 1,
    mode: 'structured',
    overview: parsed.overview,
    attention,
    observations,
    allGood,
    recommendations,
    evidence: parsed.evidence
  };
}

function parseCanonicalMarkdown(markdown: string): {
  overview: { title: string; detail: string };
  attention: ReportPresentationItem[];
  observations: ReportPresentationItem[];
  recommendations: ReportPresentationItem[];
  evidence: ReportPresentationItem[];
} | null {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const title = /^#\s+(.+)$/.exec(lines[0] ?? '')?.[1]?.trim();
  const severityIndex = lines.findIndex((line) => /^\*\*Severity:\*\*\s*\S/.test(line));
  if (!title || severityIndex < 0) return null;

  const sections: Record<StructuredSection, ReportPresentationItem[]> = {
    attention: [], observations: [], recommendations: [], evidence: []
  };
  const overviewLines: string[] = [];
  let currentSection: StructuredSection | null = null;

  for (let index = severityIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line) continue;
    const heading = /^##\s+(.+)$/.exec(line)?.[1]?.trim().toLowerCase();
    if (heading) {
      const section = SECTION_HEADINGS[heading];
      if (!section) return null;
      currentSection = section;
      continue;
    }
    if (!currentSection) {
      overviewLines.push(line);
      continue;
    }
    const item = parseItem(line, currentSection, sections[currentSection].length + 1);
    if (!item) return null;
    sections[currentSection].push(item);
  }

  if (overviewLines.length === 0) return null;
  return {
    overview: { title, detail: overviewLines.join(' ') },
    attention: sections.attention,
    observations: sections.observations,
    recommendations: sections.recommendations,
    evidence: sections.evidence
  };
}

function parseItem(line: string, section: StructuredSection, position: number): ReportPresentationItem | null {
  const match = ITEM_PATTERN.exec(line);
  if (!match) return null;
  const [, title, rawSeverity, detail] = match;
  if (!title || !detail) return null;
  if (rawSeverity && !isPresentationSeverity(rawSeverity)) return null;
  const severity = rawSeverity && isPresentationSeverity(rawSeverity) ? rawSeverity : undefined;
  if ((section === 'attention' || section === 'observations') && !severity) return null;
  if (section === 'observations' && severity !== 'info') return null;
  if (section === 'attention' && severity !== 'critical' && severity !== 'warning') return null;
  return { id: `${section}-${position}`, ...(severity ? { severity } : {}), title, detail };
}

function isPresentationSeverity(value: string): value is NonNullable<ReportPresentationItem['severity']> {
  return value === 'critical' || value === 'warning' || value === 'info';
}

function hasActionableIncidents(report: ReportSource): boolean {
  return report.summary.severityCounts.critical + report.summary.severityCounts.warning > 0;
}

function severityRank(severity: ReportPresentationItem['severity']): number {
  return severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2;
}
