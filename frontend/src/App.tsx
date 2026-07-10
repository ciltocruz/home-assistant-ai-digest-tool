import './styles.css';

const setupSteps = ['Connect Home Assistant', 'Choose AI provider', 'Set privacy level', 'Run first digest'];

export function App() {
  return (
    <main className="app-shell">
      <section className="hero-panel" aria-labelledby="product-title">
        <p className="eyebrow">Docker-first incident briefing</p>
        <h1 id="product-title">Home Assistant AI Digest</h1>
        <p className="hero-copy">Turn Home Assistant warnings, unavailable entities, stale sensors, and delivery failures into a private daily briefing you can act on.</p>
        <div className="privacy-card">Secrets are sent only to the local backend and displayed as masks after validation.</div>
      </section>

      <section className="panel" aria-labelledby="onboarding-title">
        <div className="section-heading">
          <p className="eyebrow">First run</p>
          <h2 id="onboarding-title">Guided onboarding</h2>
        </div>
        <ol className="setup-rail">
          {setupSteps.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <form className="setup-grid">
          <label>Home Assistant URL<input placeholder="http://homeassistant.local:8123" /></label>
          <label>AI provider<select defaultValue="gemini"><option value="gemini">Gemini</option><option value="openai">OpenAI</option></select></label>
          <label>Notifier<select defaultValue="telegram"><option value="telegram">Telegram</option><option value="markdown">Markdown report</option></select></label>
          <button type="button">Validate setup</button>
        </form>
      </section>

      <section className="dashboard-grid" aria-label="Dashboard overview">
        <article className="panel action-panel">
          <p className="eyebrow">Digest control</p>
          <h2>Manual digest</h2>
          <p>Run a redacted scan now and queue the report without waiting for the next schedule.</p>
          <button type="button">Run digest</button>
        </article>

        <article className="panel">
          <p className="eyebrow">History</p>
          <h2>No digests yet</h2>
          <p>Your local history will show severity counts, delivery status, and report windows after the first run.</p>
        </article>

        <article className="panel">
          <p className="eyebrow">Operator context</p>
          <h2>Add a note</h2>
          <p>Attach maintenance windows or weird behavior so the next digest can explain what happened in context.</p>
        </article>

        <article className="panel">
          <p className="eyebrow">Noise control</p>
          <h2>Ignored warnings</h2>
          <p>Keep known noisy entities out of future digests without deleting the rule history.</p>
        </article>

        <article className="panel">
          <p className="eyebrow">Delivery check</p>
          <h2>Telegram test-send</h2>
          <p>Send a safe test message through the stored notifier reference. Tokens stay masked.</p>
          <button type="button">Send test</button>
        </article>

        <article className="panel">
          <p className="eyebrow">Settings</p>
          <h2>Daily schedule</h2>
          <p>Balanced privacy, 30-day retention, and daily plus weekly summary windows are ready to tune.</p>
        </article>
      </section>
    </main>
  );
}
