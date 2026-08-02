import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { MAX_RETENTION_DAYS, type EditableSettingsDto, type IgnoreRuleCreate, type IgnoreRuleDto, type NoteCreate, type NoteDto, type SettingsUpdateCommand, type TestResult } from '@ha-digest/shared';
import { ConfirmDialog, LiveFeedback } from './feedback.js';

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
const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'connection', label: 'Conexión' }, { id: 'ai', label: 'IA' }, { id: 'notifications', label: 'Notificaciones' },
  { id: 'schedule', label: 'Horario' }, { id: 'privacy', label: 'Privacidad' }, { id: 'context', label: 'Contexto' }
];

export function SettingsPanel({ api, section }: { api?: SettingsApi; section?: string }) {
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
      setFeedback('No se pudieron cargar los ajustes. Compruebe la sesión y vuelva a intentarlo.'); setStatus('error');
    });
    void loadContext(api, 'notes', active, setNotes, setNotesState, setContextError);
    void loadContext(api, 'ignores', active, setIgnores, setIgnoresState, setContextError);
    return () => { active = false; };
  }, [api]);

  const dirty = useMemo(() => Boolean(form && settings && JSON.stringify(form) !== JSON.stringify(toFormState(settings))), [form, settings]);
  useEffect(() => {
    if (!dirty) return;
    const protectChanges = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protectChanges);
    return () => window.removeEventListener('beforeunload', protectChanges);
  }, [dirty]);

  if (!api) return <section className="panel" aria-labelledby="settings-title"><h1 id="settings-title">Configuración</h1><p>Inicie sesión para revisar y modificar la configuración.</p></section>;
  if (!form || !settings || status === 'loading') return <section className="panel" aria-labelledby="settings-title"><h1 id="settings-title">Configuración</h1><p aria-live="polite">Cargando los ajustes guardados…</p></section>;
  const configuredApi = api;
  const activeForm = form;

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
    setErrors((current) => ({ ...current, [key]: undefined }));
    setFeedback('');
  };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateForm(activeForm);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors); setFeedback('Revise los campos indicados antes de guardar.');
      queueMicrotask(() => firstError.current?.focus());
      return;
    }
    const command = toCommand(activeForm);
    if (!command) return;
    setStatus('saving'); setFeedback('Guardando ajustes…');
    try {
      const saved = await configuredApi.updateSettings(command);
      setSettings(saved); setForm(toFormState(saved)); setStatus('ready'); setFeedback('Los ajustes se guardaron correctamente.');
    } catch {
      setStatus('error'); setFeedback('No se pudieron guardar los ajustes. Compruebe los campos y vuelva a intentarlo.');
    }
  }

  async function saveNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configuredApi.addNote || !noteText.trim()) return;
    setNotesState('saving'); setContextError('');
    try { const note = await configuredApi.addNote({ text: noteText.trim(), occurredAt: new Date().toISOString(), tags: [] }); setNotes((current) => [note, ...current]); setNoteText(''); setNotesState('idle'); setFeedback('La nota se guardó correctamente.'); }
    catch { setNotesState('error'); setContextError('No se pudo guardar la nota. Revise el texto y vuelva a intentarlo.'); }
  }

  async function saveIgnore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configuredApi.addIgnore || !ignoreMatch.trim()) return;
    setIgnoresState('saving'); setContextError('');
    try { const rule = await configuredApi.addIgnore({ match: ignoreMatch.trim(), type: 'entity' }); setIgnores((current) => [rule, ...current]); setIgnoreMatch(''); setIgnoresState('idle'); setFeedback('El aviso se añadió a los ignorados.'); }
    catch { setIgnoresState('error'); setContextError('No se pudo guardar el aviso ignorado. Revise el valor y vuelva a intentarlo.'); }
  }

  async function confirmIgnoreRemoval() {
    if (!removeTarget || !configuredApi.removeIgnore) return;
    const removed = removeTarget;
    setIgnoresState('saving'); setContextError('');
    try { await configuredApi.removeIgnore(removed.id); setIgnores((current) => current.filter((rule) => rule.id !== removed.id)); setRemoveTarget(null); setRetryTarget(null); setIgnoresState('idle'); setFeedback('El aviso ignorado se quitó correctamente.'); }
    catch { setRemoveTarget(null); setRetryTarget(removed); setIgnoresState('error'); setContextError('No se pudo quitar el aviso ignorado. El aviso sigue disponible; vuelva a intentarlo.'); }
  }

  async function testNotifier() {
    if (!configuredApi.testCurrentNotifier) return;
    setFeedback('Enviando la prueba de Telegram…');
    try { const result = await configuredApi.testCurrentNotifier(); setFeedback(result.message || 'La prueba de Telegram se envió correctamente.'); }
    catch { setFeedback('No se pudo enviar la prueba de Telegram. Revise la configuración y vuelva a intentarlo.'); }
  }

  const selectedSection = SECTIONS.some(({ id }) => id === section) ? section as SettingsSection : 'connection';
  return <section className="panel settings-panel" aria-labelledby="settings-title">
    <div className="section-heading"><p className="eyebrow">Configuración</p><h1 id="settings-title">Conexiones, horario y privacidad</h1><p>Los secretos actuales se muestran solo enmascarados. Puede conservarlos o sustituirlos de forma explícita.</p></div>
    <nav className="settings-navigation" aria-label="Secciones de configuración">{SECTIONS.map(({ id, label }) => <a key={id} href={`/settings?section=${id}`} aria-current={selectedSection === id ? 'page' : undefined}>{label}</a>)}</nav>
    <LiveFeedback message={feedback} error={status === 'error' || notesState === 'error' || ignoresState === 'error'} />
    {contextError ? <><p className="error-copy" role="alert">{contextError}</p>{retryTarget ? <button type="button" className="secondary-action" onClick={() => setRemoveTarget(retryTarget)}>Reintentar eliminación</button> : null}</> : null}
    <form className="control-form settings-form" onSubmit={(event) => void save(event)} noValidate>
      <fieldset id="settings-connection"><legend>Home Assistant</legend>
        <FieldError error={errors.haUrl}><label>URL de Home Assistant<input ref={(element) => { if (errors.haUrl) firstError.current = element; }} name="haUrl" type="url" autoComplete="url" aria-describedby={errors.haUrl ? 'ha-url-error' : undefined} value={form.haUrl} onChange={(event) => update('haUrl', event.currentTarget.value)} /></label></FieldError>
        <SecretControls label="Token de Home Assistant" name="haToken" mask={settings.homeAssistant.token.mask} configured={settings.homeAssistant.token.configured} operation={form.haTokenOperation} value={form.haToken} onOperation={(operation) => update('haTokenOperation', operation)} onValue={(value) => update('haToken', value)} />
      </fieldset>
      <fieldset id="settings-ai"><legend>Proveedor de IA</legend>
        <label>Proveedor<select name="aiProvider" value={form.aiProvider} onChange={(event) => update('aiProvider', event.currentTarget.value as FormState['aiProvider'])}><option value="gemini">Gemini</option><option value="openai">OpenAI</option></select></label>
        <SecretControls label="Clave del proveedor" name="aiKey" mask={settings.ai.key.mask} configured={settings.ai.key.configured} operation={form.aiKeyOperation} value={form.aiKey} onOperation={(operation) => update('aiKeyOperation', operation)} onValue={(value) => update('aiKey', value)} />
      </fieldset>
      <fieldset id="settings-notifications"><legend>Notificaciones</legend>
        <label>Canal<select name="notificationChannel" value={form.notificationChannel} onChange={(event) => update('notificationChannel', event.currentTarget.value as FormState['notificationChannel'])}><option value="none">No enviar notificaciones</option><option value="telegram">Telegram</option></select></label>
        {form.notificationChannel === 'telegram' ? <><label>Chat de Telegram<input name="telegramChatId" autoComplete="off" value={form.telegramChatId} onChange={(event) => update('telegramChatId', event.currentTarget.value)} /></label><SecretControls label="Token del bot de Telegram" name="telegramBotToken" mask={settings.notifications.channel === 'telegram' ? settings.notifications.botToken.mask : undefined} configured={settings.notifications.channel === 'telegram' && settings.notifications.botToken.configured} operation={form.telegramOperation} value={form.telegramBotToken} onOperation={(operation) => update('telegramOperation', operation)} onValue={(value) => update('telegramBotToken', value)} /><button type="button" disabled={!api.testCurrentNotifier} onClick={() => void testNotifier()}>Enviar prueba de Telegram</button></> : null}
      </fieldset>
      <fieldset id="settings-schedule"><legend>Horario</legend>
        <label>Frecuencia<select name="scheduleKind" value={form.scheduleKind} onChange={(event) => update('scheduleKind', event.currentTarget.value as FormState['scheduleKind'])}><option value="daily">Diaria</option><option value="weekly">Semanal</option></select></label>
        <FieldError error={errors.scheduleTime}><label>Hora<input name="scheduleTime" type="time" autoComplete="off" value={form.scheduleTime} onChange={(event) => update('scheduleTime', event.currentTarget.value)} /></label></FieldError>
        <FieldError error={errors.timezone}><label>Zona horaria<input name="timezone" autoComplete="off" value={form.timezone} onChange={(event) => update('timezone', event.currentTarget.value)} /></label></FieldError>
        {form.scheduleKind === 'weekly' ? <label>Día de la semana<select name="dayOfWeek" value={form.dayOfWeek} onChange={(event) => update('dayOfWeek', event.currentTarget.value)}>{['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'].map((label, day) => <option key={label} value={day}>{label}</option>)}</select></label> : null}
        <label className="checkbox-label"><input name="scheduleEnabled" type="checkbox" checked={form.scheduleEnabled} onChange={(event) => update('scheduleEnabled', event.currentTarget.checked)} />Activar este horario</label>
      </fieldset>
      <fieldset id="settings-privacy"><legend>Privacidad y retención</legend>
        <label>Nivel de detalle<select name="privacyLevel" value={form.privacyLevel} onChange={(event) => update('privacyLevel', event.currentTarget.value as FormState['privacyLevel'])}><option value="minimal">Mínimo</option><option value="balanced">Equilibrado</option><option value="detailed">Detallado</option></select></label>
        <FieldError error={errors.retentionDays}><label>Días de retención<input name="retentionDays" type="number" inputMode="numeric" autoComplete="off" min="1" max={MAX_RETENTION_DAYS} value={form.retentionDays} onChange={(event) => update('retentionDays', event.currentTarget.value)} /></label></FieldError>
      </fieldset>
      <div className="settings-actions"><button type="submit" disabled={status === 'saving'}>{status === 'saving' ? 'Guardando ajustes…' : 'Guardar ajustes'}</button>{dirty ? <button type="button" className="secondary-action" onClick={() => { setForm(toFormState(settings)); setErrors({}); setFeedback('Los cambios sin guardar se descartaron.'); }}>Cancelar cambios</button> : null}</div>
    </form>
    <section id="settings-context" className="settings-context" aria-labelledby="settings-context-title"><p className="eyebrow">Contexto</p><h2 id="settings-context-title">Notas y avisos ignorados</h2><p>Conserve el contexto operativo junto a la configuración para evitar cambios duplicados en el panel.</p>
      <div className="settings-context-grid"><article><h3>Notas del operador</h3>{api.addNote ? <form className="control-form" aria-label="Añadir nota" onSubmit={(event) => void saveNote(event)}><label>Nota<textarea name="noteText" value={noteText} onChange={(event) => setNoteText(event.currentTarget.value)} /></label><button type="submit" disabled={notesState === 'saving'}>{notesState === 'saving' ? 'Guardando nota…' : 'Guardar nota'}</button></form> : <p className="muted-copy">Las notas no están disponibles en esta sesión.</p>}<ContextList items={notes} state={notesState} empty="No hay notas guardadas." render={(note) => <><strong>{formatDate(note.occurredAt)}</strong><span>{note.text}</span></>} /></article>
      <article><h3>Avisos ignorados</h3>{api.addIgnore ? <form className="control-form" aria-label="Añadir aviso ignorado" onSubmit={(event) => void saveIgnore(event)}><label>Coincidencia<input name="ignoreMatch" autoComplete="off" value={ignoreMatch} onChange={(event) => setIgnoreMatch(event.currentTarget.value)} /></label><button type="submit" disabled={ignoresState === 'saving'}>{ignoresState === 'saving' ? 'Guardando aviso…' : 'Ignorar aviso'}</button></form> : <p className="muted-copy">Los avisos ignorados no están disponibles en esta sesión.</p>}<ContextList items={ignores} state={ignoresState} empty="No hay avisos ignorados." render={(rule) => <><strong>{rule.match}</strong><span>{rule.reason ?? 'Sin motivo registrado'}</span>{api.removeIgnore ? <button type="button" data-testid={`remove-ignore-${rule.id}`} onClick={(event) => { event.currentTarget.focus(); setRetryTarget(null); setRemoveTarget(rule); }}>Quitar</button> : null}</>} /></article></div>
    </section>
    <ConfirmDialog open={Boolean(removeTarget)} title="Quitar aviso ignorado" description={removeTarget ? `El aviso “${removeTarget.match}” volverá a aparecer en los próximos informes.` : ''} confirmLabel="Quitar aviso" onCancel={() => setRemoveTarget(null)} onConfirm={() => void confirmIgnoreRemoval()} />
  </section>;
}

function loadContext(api: SettingsApi, kind: 'notes' | 'ignores', active: boolean, setItems: (items: never[]) => void, setState: (state: ContextState) => void, setError: (error: string) => void) {
  const operation = kind === 'notes' ? api.listNotes?.(ALL_NOTES_WINDOW) : api.listIgnores?.();
  if (!operation) return;
  setState('loading');
  operation.then((items) => { if (active) { setItems(items as never[]); setState('idle'); } }).catch(() => { if (active) { setState('error'); setError(kind === 'notes' ? 'No se pudieron cargar las notas. Vuelva a intentarlo.' : 'No se pudieron cargar los avisos ignorados. Vuelva a intentarlo.'); } });
}

function ContextList<T extends { id: string }>({ items, state, empty, render }: { items: T[]; state: ContextState; empty: string; render(item: T): React.ReactNode }) {
  if (state === 'loading') return <p aria-live="polite">Cargando…</p>;
  if (items.length === 0) return <p className="muted-copy">{empty}</p>;
  return <ul className="compact-list">{items.map((item) => <li key={item.id}>{render(item)}</li>)}</ul>;
}

function FieldError({ error, children }: { error?: string; children: React.ReactNode }) { return <>{children}{error ? <p className="field-error" id={error === 'Indica una URL válida de Home Assistant.' ? 'ha-url-error' : undefined} role="alert">{error}</p> : null}</>; }

function SecretControls({ label, name, mask, configured, operation, value, onOperation, onValue }: { label: string; name: string; mask?: string; configured: boolean; operation: 'keep_current' | 'replace'; value: string; onOperation(operation: 'keep_current' | 'replace'): void; onValue(value: string): void }) {
  return <fieldset className="secret-controls"><legend>{label}</legend><p className="muted-copy">{configured ? `Configurado: ${mask ?? 'oculto'}` : 'No configurado todavía.'}</p><label><input type="radio" name={`${name}Operation`} checked={operation === 'keep_current'} onChange={() => onOperation('keep_current')} />Conservar el valor actual</label><label><input type="radio" name={`${name}Operation`} value={`replace-${name === 'aiKey' ? 'ai-key' : name}`} checked={operation === 'replace'} onChange={() => onOperation('replace')} />Reemplazar con un valor nuevo</label>{operation === 'replace' ? <label>Nuevo valor<input name={name} type="password" required value={value} onChange={(event) => onValue(event.currentTarget.value)} autoComplete="new-password" /></label> : null}</fieldset>;
}

function toFormState(settings: EditableSettingsDto): FormState { const schedule = settings.schedules[0] ?? { kind: 'daily' as const, enabled: true, time: '08:00', timezone: 'Europe/Madrid' }; return { haUrl: settings.homeAssistant.url, haTokenOperation: 'keep_current', haToken: '', aiProvider: settings.ai.provider, aiKeyOperation: 'keep_current', aiKey: '', notificationChannel: settings.notifications.channel, telegramChatId: settings.notifications.channel === 'telegram' ? settings.notifications.chatId : '', telegramOperation: 'keep_current', telegramBotToken: '', scheduleKind: schedule.kind, scheduleEnabled: schedule.enabled, scheduleTime: schedule.time, timezone: schedule.timezone, dayOfWeek: schedule.kind === 'weekly' ? String(schedule.dayOfWeek) : '1', privacyLevel: settings.privacyLevel, retentionDays: String(settings.retentionDays) }; }
function validateForm(form: FormState): FormErrors { const errors: FormErrors = {}; try { const url = new URL(form.haUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { errors.haUrl = 'Indica una URL válida de Home Assistant.'; } if (!form.scheduleTime) errors.scheduleTime = 'Indica una hora válida.'; if (!form.timezone.trim()) errors.timezone = 'Indica una zona horaria.'; const retentionDays = Number(form.retentionDays); if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS) errors.retentionDays = `Use entre 1 y ${MAX_RETENTION_DAYS} días de retención.`; return errors; }
function toCommand(form: FormState): SettingsUpdateCommand | null { if (Object.keys(validateForm(form)).length > 0) return null; const dayOfWeek = Number(form.dayOfWeek); return { homeAssistant: { url: form.haUrl, token: form.haTokenOperation === 'replace' ? { operation: 'replace', value: form.haToken } : { operation: 'keep_current' } }, ai: { provider: form.aiProvider, key: form.aiKeyOperation === 'replace' ? { operation: 'replace', value: form.aiKey } : { operation: 'keep_current' } }, notifications: form.notificationChannel === 'telegram' ? { channel: 'telegram', chatId: form.telegramChatId, botToken: form.telegramOperation === 'replace' ? { operation: 'replace', value: form.telegramBotToken } : { operation: 'keep_current' } } : { channel: 'none' }, schedules: [form.scheduleKind === 'daily' ? { kind: 'daily', enabled: form.scheduleEnabled, time: form.scheduleTime, timezone: form.timezone } : { kind: 'weekly', enabled: form.scheduleEnabled, time: form.scheduleTime, timezone: form.timezone, dayOfWeek }], privacyLevel: form.privacyLevel, retentionDays: Number(form.retentionDays) }; }
function formatDate(value: string): string { return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(value)).replace('.', ''); }
