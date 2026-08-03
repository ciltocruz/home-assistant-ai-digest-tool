import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { MAX_RETENTION_DAYS, type EditableSettingsDto, type IgnoreRuleCreate, type IgnoreRuleDto, type NoteCreate, type NoteDto, type SettingsUpdateCommand, type TestResult } from '@ha-digest/shared';
import { ConfirmDialog, LiveFeedback } from './feedback.js';
import { currentLocale, messages, tForLocale, type TranslationKey } from './i18n/index.js';

export type SettingsApi = {
  getSettings(): Promise<EditableSettingsDto>;
  updateSettings(input: SettingsUpdateCommand): Promise<EditableSettingsDto>;
  listNotes?(window: { from: string; to: string }): Promise<NoteDto[]>;
  addNote?(input: NoteCreate): Promise<NoteDto>;
  listIgnores?(): Promise<IgnoreRuleDto[]>;
  addIgnore?(input: IgnoreRuleCreate): Promise<IgnoreRuleDto>;
  removeIgnore?(id: string): Promise<void>;
  testCurrentNotifier?(): Promise<TestResult>;
};

type FormState = {
  haUrl: string; haTokenOperation: 'keep_current' | 'replace'; haToken: string;
  aiProvider: EditableSettingsDto['ai']['provider']; aiKeyOperation: 'keep_current' | 'replace'; aiKey: string;
  notificationChannel: 'none' | 'telegram'; telegramChatId: string; telegramOperation: 'keep_current' | 'replace'; telegramBotToken: string;
  scheduleKind: 'daily' | 'weekly'; scheduleEnabled: boolean; scheduleTime: string; timezone: string; dayOfWeek: string;
  privacyLevel: EditableSettingsDto['privacyLevel']; retentionDays: string;
};

type FormErrors = Partial<Record<keyof FormState, string>>;
type SettingsSection = 'connection' | 'ai' | 'notifications' | 'schedule' | 'privacy' | 'context';
type ContextState = 'idle' | 'loading' | 'saving' | 'error';

const ALL_NOTES_WINDOW = { from: '1970-01-01T00:00:00.000Z', to: '9999-12-31T23:59:59.000Z' };
const SECTION_KEYS: Array<{ id: SettingsSection; label: TranslationKey }> = [
  { id: 'connection', label: 'settings.homeAssistant' }, { id: 'ai', label: 'settings.ai' }, { id: 'notifications', label: 'settings.notifications' },
  { id: 'schedule', label: 'settings.schedule' }, { id: 'privacy', label: 'settings.privacyRetention' }, { id: 'context', label: 'settings.context' }
];

export function SettingsPanel({ api, section }: { api?: SettingsApi; section?: string }) {
  const locale = currentLocale();
  const copy = (key: TranslationKey) => tForLocale(locale, key);
  const [settings, setSettings] = useState<EditableSettingsDto | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'error'>(api ? 'loading' : 'error');
  const [errors, setErrors] = useState<FormErrors>({});
  const [feedback, setFeedback] = useState('');
  const [notes, setNotes] = useState<NoteDto[]>([]);
  const [ignores, setIgnores] = useState<IgnoreRuleDto[]>([]);
  const [notesState, setNotesState] = useState<ContextState>('idle');
  const [ignoresState, setIgnoresState] = useState<ContextState>('idle');
  const [contextError, setContextError] = useState('');
  const [noteText, setNoteText] = useState('');
  const [ignoreMatch, setIgnoreMatch] = useState('');
  const [removeTarget, setRemoveTarget] = useState<IgnoreRuleDto | null>(null);
  const [retryTarget, setRetryTarget] = useState<IgnoreRuleDto | null>(null);
  const firstError = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!api) return;
    let active = true;
    setStatus('loading');
    void api.getSettings().then((loaded) => {
      if (!active) return;
      setSettings(loaded); setForm(toFormState(loaded)); setStatus('ready');
    }).catch(() => {
      if (!active) return;
      setFeedback(copy('settings.loadError')); setStatus('error');
    });
    void loadContext(api, 'notes', active, setNotes, setNotesState, setContextError);
    void loadContext(api, 'ignores', active, setIgnores, setIgnoresState, setContextError);
    return () => { active = false; };
  }, [api, locale]);

  const dirty = useMemo(() => Boolean(form && settings && JSON.stringify(form) !== JSON.stringify(toFormState(settings))), [form, settings]);
  useEffect(() => {
    if (!dirty) return;
    const protectChanges = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protectChanges);
    return () => window.removeEventListener('beforeunload', protectChanges);
  }, [dirty]);

  if (!api) return <section className="panel" aria-labelledby="settings-title"><h1 id="settings-title">{copy('settings.title')}</h1><p>{copy('settings.signIn')}</p></section>;
  if (!form || !settings || status === 'loading') return <section className="panel" aria-labelledby="settings-title"><h1 id="settings-title">{copy('settings.title')}</h1><p aria-live="polite">{copy('settings.loading')}</p></section>;
  const configuredApi = api;
  const activeForm = form;

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
    setErrors((current) => ({ ...current, [key]: undefined }));
    setFeedback('');
  };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateForm(activeForm, copy);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors); setFeedback(copy('settings.review'));
      queueMicrotask(() => firstError.current?.focus());
      return;
    }
    const command = toCommand(activeForm, copy);
    if (!command) return;
    setStatus('saving'); setFeedback(copy('settings.saving'));
    try {
      const saved = await configuredApi.updateSettings(command);
      setSettings(saved); setForm(toFormState(saved)); setStatus('ready'); setFeedback(copy('settings.saved'));
    } catch {
      setStatus('error'); setFeedback(copy('settings.saveError'));
    }
  }

  async function saveNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configuredApi.addNote || !noteText.trim()) return;
    setNotesState('saving'); setContextError('');
    try { const note = await configuredApi.addNote({ text: noteText.trim(), occurredAt: new Date().toISOString(), tags: [] }); setNotes((current) => [note, ...current]); setNoteText(''); setNotesState('idle'); setFeedback(copy('settings.noteSaved')); }
    catch { setNotesState('error'); setContextError(copy('settings.noteError')); }
  }

  async function saveIgnore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configuredApi.addIgnore || !ignoreMatch.trim()) return;
    setIgnoresState('saving'); setContextError('');
    try { const rule = await configuredApi.addIgnore({ match: ignoreMatch.trim(), type: 'entity' }); setIgnores((current) => [rule, ...current]); setIgnoreMatch(''); setIgnoresState('idle'); setFeedback(copy('settings.ignoreSaved')); }
    catch { setIgnoresState('error'); setContextError(copy('settings.ignoreError')); }
  }

  async function confirmIgnoreRemoval() {
    if (!removeTarget || !configuredApi.removeIgnore) return;
    const removed = removeTarget;
    setIgnoresState('saving'); setContextError('');
    try { await configuredApi.removeIgnore(removed.id); setIgnores((current) => current.filter((rule) => rule.id !== removed.id)); setRemoveTarget(null); setRetryTarget(null); setIgnoresState('idle'); setFeedback(copy('settings.ignoreRemoved')); }
    catch { setRemoveTarget(null); setRetryTarget(removed); setIgnoresState('error'); setContextError(copy('settings.ignoreRemoveError')); }
  }

  async function testNotifier() {
    if (!configuredApi.testCurrentNotifier) return;
    setFeedback(copy('settings.testingTelegram'));
    try { const result = await configuredApi.testCurrentNotifier(); setFeedback(result.message || copy('settings.telegramSent')); }
    catch { setFeedback(copy('settings.telegramError')); }
  }

  const selectedSection = SECTION_KEYS.some(({ id }) => id === section) ? section as SettingsSection : 'connection';
  return <section className="panel settings-panel" aria-labelledby="settings-title">
    <div className="section-heading"><p className="eyebrow">{copy('settings.eyebrow')}</p><h1 id="settings-title">{copy('settings.heading')}</h1><p>{copy('settings.secretDescription')}</p></div>
    <nav className="settings-navigation" aria-label={copy('settings.navigation')}>{SECTION_KEYS.map(({ id, label }) => <a key={id} href={`/settings?section=${id}`} aria-current={selectedSection === id ? 'page' : undefined}>{copy(label)}</a>)}</nav>
    <LiveFeedback message={feedback} error={status === 'error' || notesState === 'error' || ignoresState === 'error'} />
    {contextError ? <><p className="error-copy" role="alert">{contextError}</p>{retryTarget ? <button type="button" className="secondary-action" onClick={() => setRemoveTarget(retryTarget)}>{copy('settings.retryRemoval')}</button> : null}</> : null}
    <form className="control-form settings-form" onSubmit={(event) => void save(event)} noValidate>
      <fieldset id="settings-connection"><legend>{copy('settings.homeAssistant')}</legend>
        <FieldError error={errors.haUrl}><label>{copy('settings.homeAssistantUrl')}<input ref={(element) => { if (errors.haUrl) firstError.current = element; }} name="haUrl" type="url" autoComplete="url" aria-describedby={errors.haUrl ? 'ha-url-error' : undefined} value={form.haUrl} onChange={(event) => update('haUrl', event.currentTarget.value)} /></label></FieldError>
        <SecretControls copy={copy} label={copy('settings.homeAssistantToken')} name="haToken" mask={settings.homeAssistant.token.mask} configured={settings.homeAssistant.token.configured} operation={form.haTokenOperation} value={form.haToken} onOperation={(operation) => update('haTokenOperation', operation)} onValue={(value) => update('haToken', value)} />
      </fieldset>
      <fieldset id="settings-ai"><legend>{copy('settings.ai')}</legend>
        <label>{copy('settings.provider')}<select name="aiProvider" value={form.aiProvider} onChange={(event) => update('aiProvider', event.currentTarget.value as FormState['aiProvider'])}><option value="gemini">Gemini</option><option value="openai">OpenAI</option></select></label>
        <SecretControls copy={copy} label={copy('settings.providerKey')} name="aiKey" mask={settings.ai.key.mask} configured={settings.ai.key.configured} operation={form.aiKeyOperation} value={form.aiKey} onOperation={(operation) => update('aiKeyOperation', operation)} onValue={(value) => update('aiKey', value)} />
      </fieldset>
      <fieldset id="settings-notifications"><legend>{copy('settings.notifications')}</legend>
        <label>{copy('settings.channel')}<select name="notificationChannel" value={form.notificationChannel} onChange={(event) => update('notificationChannel', event.currentTarget.value as FormState['notificationChannel'])}><option value="none">{copy('settings.noNotifications')}</option><option value="telegram">Telegram</option></select></label>
        {form.notificationChannel === 'telegram' ? <><label>{copy('settings.telegramChat')}<input name="telegramChatId" autoComplete="off" value={form.telegramChatId} onChange={(event) => update('telegramChatId', event.currentTarget.value)} /></label><SecretControls copy={copy} label={copy('settings.telegramBotToken')} name="telegramBotToken" mask={settings.notifications.channel === 'telegram' ? settings.notifications.botToken.mask : undefined} configured={settings.notifications.channel === 'telegram' && settings.notifications.botToken.configured} operation={form.telegramOperation} value={form.telegramBotToken} onOperation={(operation) => update('telegramOperation', operation)} onValue={(value) => update('telegramBotToken', value)} /><button type="button" disabled={!api.testCurrentNotifier} onClick={() => void testNotifier()}>{copy('settings.sendTelegramTest')}</button></> : null}
      </fieldset>
      <fieldset id="settings-schedule"><legend>{copy('settings.schedule')}</legend>
        <label>{copy('settings.frequency')}<select name="scheduleKind" value={form.scheduleKind} onChange={(event) => update('scheduleKind', event.currentTarget.value as FormState['scheduleKind'])}><option value="daily">{copy('settings.daily')}</option><option value="weekly">{copy('settings.weekly')}</option></select></label>
        <FieldError error={errors.scheduleTime}><label>{copy('settings.time')}<input name="scheduleTime" type="time" autoComplete="off" value={form.scheduleTime} onChange={(event) => update('scheduleTime', event.currentTarget.value)} /></label></FieldError>
        <FieldError error={errors.timezone}><label>{copy('settings.timezone')}<input name="timezone" autoComplete="off" value={form.timezone} onChange={(event) => update('timezone', event.currentTarget.value)} /></label></FieldError>
        {form.scheduleKind === 'weekly' ? <label>{copy('settings.dayOfWeek')}<select name="dayOfWeek" value={form.dayOfWeek} onChange={(event) => update('dayOfWeek', event.currentTarget.value)}>{messages[locale].settings.weekdays.map((label, day) => <option key={label} value={day}>{label}</option>)}</select></label> : null}
        <label className="checkbox-label"><input name="scheduleEnabled" type="checkbox" checked={form.scheduleEnabled} onChange={(event) => update('scheduleEnabled', event.currentTarget.checked)} />{copy('settings.enableSchedule')}</label>
      </fieldset>
      <fieldset id="settings-privacy"><legend>{copy('settings.privacyRetention')}</legend>
        <label>{copy('settings.detailLevel')}<select name="privacyLevel" value={form.privacyLevel} onChange={(event) => update('privacyLevel', event.currentTarget.value as FormState['privacyLevel'])}><option value="minimal">{copy('settings.minimal')}</option><option value="balanced">{copy('settings.balanced')}</option><option value="detailed">{copy('settings.detailed')}</option></select></label>
        <FieldError error={errors.retentionDays}><label>{copy('settings.retentionDays')}<input name="retentionDays" type="number" inputMode="numeric" autoComplete="off" min="1" max={MAX_RETENTION_DAYS} value={form.retentionDays} onChange={(event) => update('retentionDays', event.currentTarget.value)} /></label></FieldError>
      </fieldset>
      <div className="settings-actions"><button type="submit" disabled={status === 'saving'}>{status === 'saving' ? copy('settings.saving') : copy('settings.save')}</button>{dirty ? <button type="button" className="secondary-action" onClick={() => { setForm(toFormState(settings)); setErrors({}); setFeedback(copy('settings.changesDiscarded')); }}>{copy('settings.cancel')}</button> : null}</div>
    </form>
    <section id="settings-context" className="settings-context" aria-labelledby="settings-context-title"><p className="eyebrow">{copy('settings.context')}</p><h2 id="settings-context-title">{copy('settings.contextTitle')}</h2><p>{copy('settings.contextDescription')}</p>
      <div className="settings-context-grid"><article><h3>{copy('settings.operatorNotes')}</h3>{api.addNote ? <form className="control-form" aria-label={copy('settings.addNote')} onSubmit={(event) => void saveNote(event)}><label>{copy('settings.note')}<textarea name="noteText" value={noteText} onChange={(event) => setNoteText(event.currentTarget.value)} /></label><button type="submit" disabled={notesState === 'saving'}>{notesState === 'saving' ? copy('settings.savingNote') : copy('settings.saveNote')}</button></form> : <p className="muted-copy">{copy('settings.notesUnavailable')}</p>}<ContextList loading={copy('settings.loadingContext')} items={notes} state={notesState} empty={copy('settings.noNotes')} render={(note) => <><strong>{formatDate(note.occurredAt, locale)}</strong><span>{note.text}</span></>} /></article>
      <article><h3>{copy('settings.ignoredWarnings')}</h3>{api.addIgnore ? <form className="control-form" aria-label={copy('settings.addIgnoredWarning')} onSubmit={(event) => void saveIgnore(event)}><label>{copy('settings.match')}<input name="ignoreMatch" autoComplete="off" value={ignoreMatch} onChange={(event) => setIgnoreMatch(event.currentTarget.value)} /></label><button type="submit" disabled={ignoresState === 'saving'}>{ignoresState === 'saving' ? copy('settings.savingWarning') : copy('settings.ignoreWarning')}</button></form> : <p className="muted-copy">{copy('settings.ignoresUnavailable')}</p>}<ContextList loading={copy('settings.loadingContext')} items={ignores} state={ignoresState} empty={copy('settings.noIgnores')} render={(rule) => <><strong>{rule.match}</strong><span>{rule.reason ?? copy('settings.noReason')}</span>{api.removeIgnore ? <button type="button" data-testid={`remove-ignore-${rule.id}`} onClick={(event) => { event.currentTarget.focus(); setRetryTarget(null); setRemoveTarget(rule); }}>{copy('settings.remove')}</button> : null}</>} /></article></div>
    </section>
    <ConfirmDialog open={Boolean(removeTarget)} title={copy('settings.removeIgnoredTitle')} description={removeTarget ? copy('settings.removeIgnoredDescription').replace('{match}', removeTarget.match) : ''} confirmLabel={copy('settings.remove')} onCancel={() => setRemoveTarget(null)} onConfirm={() => void confirmIgnoreRemoval()} />
  </section>;
}

function loadContext(api: SettingsApi, kind: 'notes' | 'ignores', active: boolean, setItems: (items: never[]) => void, setState: (state: ContextState) => void, setError: (error: string) => void) {
  const operation = kind === 'notes' ? api.listNotes?.(ALL_NOTES_WINDOW) : api.listIgnores?.();
  if (!operation) return;
  setState('loading');
  operation.then((items) => { if (active) { setItems(items as never[]); setState('idle'); } }).catch(() => { if (active) { setState('error'); setError(tForLocale(currentLocale(), kind === 'notes' ? 'settings.loadNotesError' : 'settings.loadIgnoresError')); } });
}

function ContextList<T extends { id: string }>({ items, state, empty, loading, render }: { items: T[]; state: ContextState; empty: string; loading: string; render(item: T): React.ReactNode }) {
  if (state === 'loading') return <p aria-live="polite">{loading}</p>;
  if (items.length === 0) return <p className="muted-copy">{empty}</p>;
  return <ul className="compact-list">{items.map((item) => <li key={item.id}>{render(item)}</li>)}</ul>;
}

function FieldError({ error, children }: { error?: string; children: React.ReactNode }) { return <>{children}{error ? <p className="field-error" role="alert">{error}</p> : null}</>; }

function SecretControls({ copy, label, name, mask, configured, operation, value, onOperation, onValue }: { copy(key: TranslationKey): string; label: string; name: string; mask?: string; configured: boolean; operation: 'keep_current' | 'replace'; value: string; onOperation(operation: 'keep_current' | 'replace'): void; onValue(value: string): void }) {
  return <fieldset className="secret-controls"><legend>{label}</legend><p className="muted-copy">{configured ? copy('settings.configured').replace('{mask}', mask ?? '••••') : copy('settings.notConfigured')}</p><label><input type="radio" name={`${name}Operation`} checked={operation === 'keep_current'} onChange={() => onOperation('keep_current')} />{copy('settings.keepCurrent')}</label><label><input type="radio" name={`${name}Operation`} value={`replace-${name === 'aiKey' ? 'ai-key' : name}`} checked={operation === 'replace'} onChange={() => onOperation('replace')} />{copy('settings.replace')}</label>{operation === 'replace' ? <label>{copy('settings.newValue')}<input name={name} type="password" required value={value} onChange={(event) => onValue(event.currentTarget.value)} autoComplete="new-password" /></label> : null}</fieldset>;
}

function toFormState(settings: EditableSettingsDto): FormState { const schedule = settings.schedules[0] ?? { kind: 'daily' as const, enabled: true, time: '08:00', timezone: 'Europe/Madrid' }; return { haUrl: settings.homeAssistant.url, haTokenOperation: 'keep_current', haToken: '', aiProvider: settings.ai.provider, aiKeyOperation: 'keep_current', aiKey: '', notificationChannel: settings.notifications.channel, telegramChatId: settings.notifications.channel === 'telegram' ? settings.notifications.chatId : '', telegramOperation: 'keep_current', telegramBotToken: '', scheduleKind: schedule.kind, scheduleEnabled: schedule.enabled, scheduleTime: schedule.time, timezone: schedule.timezone, dayOfWeek: schedule.kind === 'weekly' ? String(schedule.dayOfWeek) : '1', privacyLevel: settings.privacyLevel, retentionDays: String(settings.retentionDays) }; }
function validateForm(form: FormState, copy: (key: TranslationKey) => string): FormErrors { const errors: FormErrors = {}; try { const url = new URL(form.haUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { errors.haUrl = copy('settings.validHomeAssistantUrl'); } if (!form.scheduleTime) errors.scheduleTime = copy('settings.validTime'); if (!form.timezone.trim()) errors.timezone = copy('settings.validTimezone'); const retentionDays = Number(form.retentionDays); if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS) errors.retentionDays = copy('settings.validRetention').replace('{max}', String(MAX_RETENTION_DAYS)); return errors; }
function toCommand(form: FormState, copy: (key: TranslationKey) => string): SettingsUpdateCommand | null { if (Object.keys(validateForm(form, copy)).length > 0) return null; const dayOfWeek = Number(form.dayOfWeek); return { homeAssistant: { url: form.haUrl, token: form.haTokenOperation === 'replace' ? { operation: 'replace', value: form.haToken } : { operation: 'keep_current' } }, ai: { provider: form.aiProvider, key: form.aiKeyOperation === 'replace' ? { operation: 'replace', value: form.aiKey } : { operation: 'keep_current' } }, notifications: form.notificationChannel === 'telegram' ? { channel: 'telegram', chatId: form.telegramChatId, botToken: form.telegramOperation === 'replace' ? { operation: 'replace', value: form.telegramBotToken } : { operation: 'keep_current' } } : { channel: 'none' }, schedules: [form.scheduleKind === 'daily' ? { kind: 'daily', enabled: form.scheduleEnabled, time: form.scheduleTime, timezone: form.timezone } : { kind: 'weekly', enabled: form.scheduleEnabled, time: form.scheduleTime, timezone: form.timezone, dayOfWeek }], privacyLevel: form.privacyLevel, retentionDays: Number(form.retentionDays) }; }
function formatDate(value: string, locale: 'en' | 'es'): string { return new Intl.DateTimeFormat(locale === 'es' ? 'es-ES' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(value)).replace('.', ''); }
