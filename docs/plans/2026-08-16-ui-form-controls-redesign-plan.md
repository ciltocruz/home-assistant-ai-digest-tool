# UI Form Controls Redesign (Switches & Radio Cards) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign frontend form controls in `settings.tsx`, `onboarding.tsx`, and `styles.css` to fix unstyled checkboxes and radios with modern Toggle Switches and interactive Radio Cards.

**Architecture:** Scope generic form CSS selectors in `styles.css`, replace native checkbox rendering with accessible toggle switches (`.checkbox-switch`), and replace raw radio inputs for secrets in `SecretControls` with styled radio cards (`.secret-radio-card`).

**Tech Stack:** React, Vanilla CSS, Vitest, Vite, pnpm.

---

### Task 1: CSS Scoping and Toggle Switch Styles

**Files:**
- Modify: `frontend/src/styles.css`
- Test: `frontend/src/settings.test.tsx`

- [ ] **Step 1: Write/update frontend unit tests for SecretControls and Checkbox rendering**

Check `frontend/src/settings.test.tsx` for existing tests or add a test verifying rendered form control structure.

- [ ] **Step 2: Run tests to verify initial state**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 3: Update `frontend/src/styles.css` to scope input styles and add switch/radio-card CSS**

Scope `.control-form input` to `:not([type="checkbox"]):not([type="radio"])` and add:
- `.checkbox-label` switch toggle rules
- `.secret-controls` radio card rules

- [ ] **Step 4: Verify tests pass**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/styles.css
git commit -m "style(frontend): scope form input styles and add custom toggle switch and radio card CSS"
```

---

### Task 2: Refactor SecretControls and Checkbox Components in settings.tsx

**Files:**
- Modify: `frontend/src/settings.tsx:160-198`
- Test: `frontend/src/settings.test.tsx`

- [ ] **Step 1: Refactor `SecretControls` and `checkbox-label` in `frontend/src/settings.tsx` to use custom switch markup and radio card structure**

- [ ] **Step 2: Run frontend tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/src/settings.tsx
git commit -m "feat(frontend): update settings form controls to use toggle switches and radio cards"
```

---

### Task 3: Build Verification & Deployment to Cisne

**Files:**
- Modify: `frontend/src/styles.css`, `frontend/src/settings.tsx`

- [ ] **Step 1: Run frontend build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 2: Deploy updated Docker image to Cisne**

Build image and recreate container on Cisne:
```bash
ssh cisne "cd /share/DockerVolumes/ha-digest && docker compose up -d --build"
```

- [ ] **Step 3: Verify container health on Cisne**

Run: `ssh cisne "curl -i http://127.0.0.1:38124/ready"`
Expected: HTTP 200 OK
