import { useEffect, useState } from 'react';
import { MAX_RETENTION_DAYS, type IgnoreRuleCreate, type IgnoreRuleDto, type NoteCreate, type NoteDto, type NotifierTestRequest, type RedactedSettingsDto, type TestResult } from '@ha-digest/shared';
import { ApiClientError, redactSensitiveText } from './api-client.js';
import { t } from './i18n/index.js';

export type ControlsApi = {
  getSettings(): Promise<RedactedSettingsDto>;
  updateSettings(input: RedactedSettingsDto): Promise<RedactedSettingsDto>;
  listNotes(window: { from: string; to: string }): Promise<NoteDto[]>;
  addNote(input: NoteCreate): Promise<NoteDto>;
  listIgnores(): Promise<IgnoreRuleDto[]>;
  addIgnore(input: IgnoreRuleCreate): Promise<IgnoreRuleDto>;
  removeIgnore(id: string): Promise<void>;
  testNotifier(input: NotifierTestRequest): Promise<TestResult>;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }
  | { status: 'ready'; settings: RedactedSettingsDto; notes: NoteDto[]; ignores: IgnoreRuleDto[]; testResult?: TestResult; loadErrors?: string[] };

const DEFAULT_NOTE_WINDOW = { from: '1970-01-01T00:00:00.000Z', to: '9999-12-31T23:59:59.000Z' };

export function ControlsPanel({ api, now = () => new Date().toISOString() }: { api?: ControlsApi; now?: () => string }) {
  const [state, setState] = useState<LoadState>(api ? { status: 'loading' } : { status: 'unavailable' });
  const [noteText, setNoteText] = useState('');
  const [ignoreMatch, setIgnoreMatch] = useState('');
  const [retentionDays, setRetentionDays] = useState('30');
  const [privacyLevel, setPrivacyLevel] = useState<RedactedSettingsDto['privacyLevel']>('balanced');
  const [pendingMutation, setPendingMutation] = useState<null | 'note' | 'ignore' | 'removeIgnore' | 'settings' | 'telegramTest'>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const isMutationPending = pendingMutation !== null;

  useEffect(() => {
    if (!api) {
      setState({ status: 'unavailable' });
      return;
    }

    let active = true;
    setState({ status: 'loading' });
    void loadControls(api).then((next) => {
      if (!active) return;
      setState(next);
      if (next.status === 'ready') {
        setRetentionDays(String(next.settings.retentionDays));
        setPrivacyLevel(next.settings.privacyLevel);
      }
    });
    return () => { active = false; };
  }, [api]);

  if (state.status === 'unavailable') return <UnavailableControls />;
  if (state.status === 'loading') return <section className="controls-grid"><StatusPanel title={t('dashboard.settings.title')} copy={t('dashboard.settings.copy')} /></section>;
  if (state.status === 'error') return <section className="controls-grid"><StatusPanel title={t('dashboard.settings.title')} copy={state.message} /></section>;

  async function submitNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!api || state.status !== 'ready' || !noteText.trim()) return;
    await runMutation('note', t('dashboard.mutationErrors.note'), async () => {
      const note = await api.addNote({ text: noteText.trim(), occurredAt: now(), tags: [] });
      setState((previous) => previous.status === 'ready' ? { ...previous, notes: [note, ...previous.notes] } : previous);
      setNoteText('');
    });
  }

  async function submitIgnore(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!api || state.status !== 'ready' || !ignoreMatch.trim()) return;
    await runMutation('ignore', t('dashboard.mutationErrors.ignore'), async () => {
      const rule = await api.addIgnore({ match: ignoreMatch.trim(), type: 'entity' });
      setState((previous) => previous.status === 'ready' ? { ...previous, ignores: [rule, ...previous.ignores] } : previous);
      setIgnoreMatch('');
    });
  }

  async function removeIgnore(id: string) {
    if (!api || state.status !== 'ready') return;
    await runMutation('removeIgnore', t('dashboard.mutationErrors.removeIgnore'), async () => {
      await api.removeIgnore(id);
      setState((previous) => previous.status === 'ready' ? { ...previous, ignores: previous.ignores.filter((rule) => rule.id !== id) } : previous);
    });
  }

  async function submitSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!api || state.status !== 'ready') return;
    const nextSettings = { ...state.settings, privacyLevel, retentionDays: Number(retentionDays) };
    await runMutation('settings', t('dashboard.mutationErrors.settings'), async () => {
      const updated = await api.updateSettings(nextSettings);
      setState((previous) => previous.status === 'ready' ? { ...previous, settings: updated } : previous);
    });
  }

  async function testTelegram() {
    if (!api || state.status !== 'ready') return;
    const telegramRef = state.settings.secretRefs.notifierRefs?.telegram;
    if (!telegramRef) return;
    await runMutation('telegramTest', t('dashboard.mutationErrors.telegramTest'), async () => {
      const result = await api.testNotifier({ channel: 'telegram', targetRef: telegramRef, message: t('dashboard.telegramTest.defaultMessage') });
      setState((previous) => previous.status === 'ready' ? { ...previous, testResult: result } : previous);
    });
  }

  async function runMutation(kind: NonNullable<typeof pendingMutation>, errorMessage: string, operation: () => Promise<void>) {
    if (isMutationPending) return;
    setPendingMutation(kind);
    setMutationError(null);
    try {
      await operation();
    } catch (error) {
      setMutationError(formatUserError(errorMessage, error));
    } finally {
      setPendingMutation(null);
    }
  }

  const telegramRef = state.settings.secretRefs.notifierRefs?.telegram;

  return <section className="controls-grid" aria-label={t('dashboard.ariaLabel')}>
    {mutationError ? <p className="panel error-copy" role="alert">{mutationError}</p> : null}
    {state.loadErrors?.map((message) => <p className="panel error-copy" role="alert" key={message}>{message}</p>)}
    <article className="panel">
      <p className="eyebrow">{t('dashboard.notes.eyebrow')}</p>
      <h2>{t('dashboard.notes.title')}</h2>
      <p>{t('dashboard.notes.copy')}</p>
      <form className="control-form" aria-label={t('dashboard.notes.formLabel')} onSubmit={submitNote}>
        <label>{t('dashboard.notes.textLabel')}<textarea name="noteText" value={noteText} onInput={(event) => setNoteText(event.currentTarget.value)} /></label>
        <button type="submit" disabled={isMutationPending}>{t('dashboard.notes.action')}</button>
      </form>
      <ul className="compact-list">{state.notes.map((note) => <li key={note.id}><strong>{formatDate(note.occurredAt)}</strong><span>{note.text}</span></li>)}</ul>
    </article>

    <article className="panel">
      <p className="eyebrow">{t('dashboard.ignoredWarnings.eyebrow')}</p>
      <h2>{t('dashboard.ignoredWarnings.title')}</h2>
      <p>{t('dashboard.ignoredWarnings.copy')}</p>
      <form className="control-form" aria-label={t('dashboard.ignoredWarnings.formLabel')} onSubmit={submitIgnore}>
        <label>{t('dashboard.ignoredWarnings.matchLabel')}<input name="ignoreMatch" value={ignoreMatch} onInput={(event) => setIgnoreMatch(event.currentTarget.value)} /></label>
        <button type="submit" disabled={isMutationPending}>{t('dashboard.ignoredWarnings.action')}</button>
      </form>
      <ul className="compact-list">{state.ignores.map((rule) => <li key={rule.id}><strong>{rule.match}</strong><span>{rule.reason ?? t('dashboard.ignoredWarnings.noReason')}</span><button type="button" data-testid={`remove-ignore-${rule.id}`} disabled={isMutationPending} onClick={() => void removeIgnore(rule.id)}>{t('dashboard.ignoredWarnings.remove')}</button></li>)}</ul>
    </article>

    <article className="panel">
      <p className="eyebrow">{t('dashboard.settings.eyebrow')}</p>
      <h2>{t('dashboard.settings.title')}</h2>
      <p>{t('dashboard.settings.copy')}</p>
      <form className="control-form" aria-label={t('dashboard.settings.formLabel')} onSubmit={submitSettings}>
        <label>{t('dashboard.settings.privacyLabel')}<select value={privacyLevel} onChange={(event) => setPrivacyLevel(event.currentTarget.value as RedactedSettingsDto['privacyLevel'])}><option value="minimal">{t('dashboard.settings.privacy.minimal')}</option><option value="balanced">{t('dashboard.settings.privacy.balanced')}</option><option value="detailed">{t('dashboard.settings.privacy.detailed')}</option></select></label>
        <label>{t('dashboard.settings.retentionLabel')}<input name="retentionDays" type="number" min="1" max={MAX_RETENTION_DAYS} value={retentionDays} onInput={(event) => setRetentionDays(event.currentTarget.value)} /></label>
        <p className="muted-copy">{state.settings.schedules[0]?.timezone ?? t('dashboard.settings.noSchedule')}</p>
        <button type="submit" disabled={isMutationPending}>{t('dashboard.settings.action')}</button>
      </form>
    </article>

    <article className="panel action-panel">
      <p className="eyebrow">{t('dashboard.telegramTest.eyebrow')}</p>
      <h2>{t('dashboard.telegramTest.title')}</h2>
      <p>{telegramRef ? t('dashboard.telegramTest.copy') : t('dashboard.telegramTest.missingCopy')}</p>
      <button type="button" data-testid="telegram-test" disabled={!telegramRef || isMutationPending} onClick={() => void testTelegram()}>{t('dashboard.telegramTest.action')}</button>
      {state.testResult ? <p className="muted-copy">{state.testResult.message}</p> : null}
    </article>
  </section>;
}

async function loadControls(api: ControlsApi): Promise<LoadState> {
  try {
    const settings = await api.getSettings();
    const [notesResult, ignoresResult] = await Promise.allSettled([api.listNotes(DEFAULT_NOTE_WINDOW), api.listIgnores()]);
    const loadErrors: string[] = [];
    const notes = notesResult.status === 'fulfilled' ? notesResult.value : [];
    const ignores = ignoresResult.status === 'fulfilled' ? ignoresResult.value : [];
    if (notesResult.status === 'rejected') loadErrors.push(formatUserError(t('dashboard.loadErrors.notes'), notesResult.reason));
    if (ignoresResult.status === 'rejected') loadErrors.push(formatUserError(t('dashboard.loadErrors.ignores'), ignoresResult.reason));
    return { status: 'ready', settings, notes, ignores, loadErrors };
  } catch (error) {
    const message = error instanceof ApiClientError || error instanceof Error ? redactSensitiveText(error.message) : t('dashboard.settings.copy');
    return { status: 'error', message };
  }
}

function formatUserError(message: string, error: unknown): string {
  const detail = formatSafeApiDetail(error);
  return detail ? `${message} ${detail}` : message;
}

function formatSafeApiDetail(error: unknown): string | null {
  if (!(error instanceof ApiClientError)) return null;
  const code = redactSensitiveText(error.code);
  const requestId = redactSensitiveText(error.requestId);
  return t('dashboard.errorDetail').replace('{code}', code).replace('{requestId}', requestId);
}

function StatusPanel({ title, copy }: { title: string; copy: string }) {
  return <article className="panel"><h2>{title}</h2><p>{copy}</p></article>;
}

function UnavailableControls() {
  return <section className="controls-grid">
    <StatusPanel title={t('dashboard.notes.title')} copy={t('dashboard.notes.copy')} />
    <StatusPanel title={t('dashboard.ignoredWarnings.title')} copy={t('dashboard.ignoredWarnings.copy')} />
    <StatusPanel title={t('dashboard.telegramTest.title')} copy={t('dashboard.telegramTest.missingCopy')} />
    <StatusPanel title={t('dashboard.settings.title')} copy={t('dashboard.settings.copy')} />
  </section>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(value)).replace('.', '');
}
