/**
 * Fleet tab — the default view. One card per task, a sticky summary strip, and
 * the new-task composer overlay.
 *
 * State discipline (§ tab.ts): this tab keeps nothing in the DOM between
 * renders. `render` is called from scratch on every state change and every 1s
 * tick, so it must be idempotent. All view state (which cards are expanded,
 * the open composer and its draft, steer inputs, the armed stop-all button)
 * lives on `ctx.viewState`. Full re-render is cheap at this DOM size (Spike D).
 */

import { countByPhase } from '../../core/reducer';
import { LIVE_PHASES } from '../../core/types';
import type {
  ArgusConfig,
  Effort,
  FleetState,
  ModelId,
  Task,
  TaskPhase,
  TaskSpec,
} from '../../core/types';
import { el, fmtClock, fmtCost, fmtDuration } from '../dom';
import type { Tab, TabContext } from './tab';

// ---------------------------------------------------------------------------
// Static option tables & small pure helpers
// ---------------------------------------------------------------------------

const MODEL_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['claude-fable-5', 'Fable 5'],
  ['claude-opus-4-8', 'Opus 4.8'],
  ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
];

const EFFORT_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
  ['max', 'Max'],
];

const PHASE_LABEL: Record<TaskPhase, string> = {
  DRAFT: 'Draft',
  QUEUED: 'Queued',
  RUNNING: 'Running',
  BLOCKED: 'Blocked',
  VERIFYING: 'Verifying',
  READY: 'Ready',
  MERGING: 'Merging',
  DONE: 'Done',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

/** Status colour class for a phase pill (see .pill.run/.ok/.warn/.bad). */
function pillClass(phase: TaskPhase): string {
  switch (phase) {
    case 'RUNNING':
    case 'VERIFYING':
    case 'MERGING':
      return 'run';
    case 'BLOCKED':
      return 'warn';
    case 'READY':
    case 'DONE':
      return 'ok';
    case 'FAILED':
      return 'bad';
    case 'CANCELLED':
      return 'muted';
    default:
      return '';
  }
}

/** Short, human model name extracted from a model id. */
function modelShort(id: string): string {
  const l = id.toLowerCase();
  if (l.includes('fable')) return 'fable';
  if (l.includes('opus')) return 'opus';
  if (l.includes('haiku')) return 'haiku';
  if (l.includes('sonnet')) return 'sonnet';
  return id;
}

/** title → id slug: lowercase, spaces to hyphens, strip anything else. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64);
}

/** Elapsed ms for a task: live counts up, ended is frozen at endedAt. */
function elapsedMs(t: Task, now: number): number | null {
  if (t.startedAt === null) return null;
  const start = Date.parse(t.startedAt);
  if (Number.isNaN(start)) return null;
  const end = t.endedAt !== null ? Date.parse(t.endedAt) : now;
  if (Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** Fallback activity copy when a task has emitted no tool detail yet. */
function activityText(t: Task): string {
  if (t.lastActivity !== null && t.lastActivity.length > 0) return t.lastActivity;
  switch (t.phase) {
    case 'RUNNING':
      return 'Working…';
    case 'VERIFYING':
      return 'Running verify gates…';
    case 'QUEUED':
      return 'Queued — waiting for an agent slot';
    case 'DRAFT':
      return 'Draft';
    default:
      return '';
  }
}

function sep(): HTMLElement {
  return el('span', { class: 'fleet-sep' }, '·');
}

function stat(n: number, label: string): HTMLElement {
  return el('span', {}, el('b', {}, String(n)), ` ${label}`);
}

// ---------------------------------------------------------------------------
// Draft & view-state accessors
// ---------------------------------------------------------------------------

interface Draft {
  title: string;
  id: string;
  idEdited: boolean;
  prompt: string;
  scope: string;
  model: string;
  effort: string;
  verify: string;
  budget: string;
  autoMerge: boolean;
}

interface ComposerErrors {
  title?: string;
  id?: string;
  prompt?: string;
}

function seedDraft(cfg: ArgusConfig): Draft {
  return {
    title: '',
    id: '',
    idEdited: false,
    prompt: '',
    scope: '',
    model: cfg.defaultModel,
    effort: cfg.defaultEffort,
    verify: cfg.verifyCommand ?? '',
    budget: cfg.perTaskBudgetUsd !== null ? String(cfg.perTaskBudgetUsd) : '',
    autoMerge: cfg.autoMerge,
  };
}

function getDraft(vs: Record<string, unknown>, cfg: ArgusConfig): Draft {
  let d = vs['draft'] as Draft | undefined;
  if (d === undefined) {
    d = seedDraft(cfg);
    vs['draft'] = d;
  }
  return d;
}

/** A lazily-created string-keyed map stashed on view state. */
function recMap<T>(vs: Record<string, unknown>, key: string): Record<string, T> {
  let m = vs[key] as Record<string, T> | undefined;
  if (m === undefined) {
    m = {};
    vs[key] = m;
  }
  return m;
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

export const fleetTab: Tab = {
  id: 'fleet',
  label: () => 'Fleet',

  render(root: HTMLElement, state: FleetState, ctx: TabContext): void {
    const vs = ctx.viewState;
    const cfg = state.config;

    // A local, tab-switch-free re-render for view-state-only changes (expand,
    // composer, arm/disarm). It re-runs `build` into the same root; if the user
    // has since navigated away, that root is detached and the write is a no-op.
    const rerender = (): void => {
      root.replaceChildren();
      build();
    };

    // ---- focus preservation across re-renders -----------------------------
    // The 1s tick re-renders while any task is live, which recreates the
    // composer/steer inputs and drops focus. We track the focused field key +
    // caret and restore it after the new DOM is attached.
    const recordSel = (node: HTMLElement | null): void => {
      if (node === null) return;
      const tag = node.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const inp = node as HTMLInputElement;
        try {
          if (typeof inp.selectionStart === 'number' && typeof inp.selectionEnd === 'number') {
            vs['fsel'] = [inp.selectionStart, inp.selectionEnd];
            return;
          }
        } catch {
          /* number inputs throw on selection access — ignore */
        }
      }
      vs['fsel'] = undefined;
    };
    const noteFocus = (e: Event): void => {
      const t = e.target as HTMLElement | null;
      const k = t?.getAttribute?.('data-fkey');
      if (k !== null && k !== undefined && k !== '') {
        vs['fkey'] = k;
        recordSel(t);
      }
    };
    const noteCaret = (e: Event): void => {
      const t = e.target as HTMLElement | null;
      if (t?.getAttribute?.('data-fkey')) recordSel(t);
    };
    root.addEventListener('focusin', noteFocus);
    root.addEventListener('input', noteFocus);
    root.addEventListener('keyup', noteCaret);
    root.addEventListener('click', noteCaret, true);

    const scheduleRestore = (): void => {
      requestAnimationFrame(() => {
        const key = vs['fkey'];
        if (typeof key === 'string') {
          const q = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key;
          const target = root.querySelector(`[data-fkey="${q}"]`) as HTMLElement | null;
          const ae = document.activeElement;
          if (target !== null && (ae === document.body || ae === null)) {
            target.focus();
            const s = vs['fsel'];
            if (Array.isArray(s) && typeof (target as HTMLInputElement).setSelectionRange === 'function') {
              try {
                (target as HTMLInputElement).setSelectionRange(s[0] as number, s[1] as number);
              } catch {
                /* not a text field — focus alone is enough */
              }
            }
          }
        }
        root.querySelectorAll('.fleet-tail').forEach((tail) => {
          (tail as HTMLElement).scrollTop = (tail as HTMLElement).scrollHeight;
        });
      });
    };

    // ---- shared UI factories ----------------------------------------------
    const btn = (
      label: string,
      onClick: () => void,
      variant?: string,
    ): HTMLButtonElement => {
      const b = el('button', { class: 'btn' + (variant !== undefined ? ' ' + variant : '') }, label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      return b;
    };

    const openComposer = (): void => {
      vs['composer'] = true;
      vs['fkey'] = 'c-title';
      getDraft(vs, cfg);
      rerender();
    };
    const closeComposer = (): void => {
      vs['composer'] = false;
      vs['cerrors'] = undefined;
      rerender();
    };

    // ---- header ------------------------------------------------------------
    const header = (): HTMLElement => {
      const counts = countByPhase(state);
      const running = counts.RUNNING;
      const blocked = counts.BLOCKED;
      const live = counts.RUNNING + counts.BLOCKED + counts.VERIFYING;
      const cap = cfg.maxConcurrentAgents;

      const armed =
        typeof vs['stopAllArmedAt'] === 'number' && ctx.now() - (vs['stopAllArmedAt'] as number) < 3000;
      const stopAll = el('button', { class: 'btn danger' }, armed ? 'Confirm stop all' : 'Stop all');
      stopAll.addEventListener('click', () => {
        if (armed) {
          ctx.send({ kind: 'stop-all' });
          vs['stopAllArmedAt'] = undefined;
          rerender();
        } else {
          vs['stopAllArmedAt'] = ctx.now();
          rerender();
          setTimeout(() => rerender(), 3100);
        }
      });

      const newTask = el('button', { class: 'btn primary' }, 'New task');
      newTask.addEventListener('click', () => openComposer());

      return el(
        'div',
        { class: 'fleet-header' },
        el(
          'div',
          { class: 'fleet-stats' },
          stat(running, 'running'),
          sep(),
          stat(blocked, 'blocked'),
          sep(),
          el('span', {}, `${fmtCost(state.fleetCostUsd)} est`),
          sep(),
          el('span', {}, `${live}/${cap} agents`),
        ),
        el('div', { class: 'fleet-actions' }, newTask, stopAll),
      );
    };

    // ---- one task card -----------------------------------------------------
    const card = (t: Task): HTMLElement => {
      const expandedMap = recMap<boolean>(vs, 'expanded');
      const expanded = expandedMap[t.spec.id] === true;
      const c = el('div', { class: 'card fleet-card' + (t.blockedOn !== null ? ' blocked' : '') });
      c.addEventListener('click', () => {
        expandedMap[t.spec.id] = !expandedMap[t.spec.id];
        rerender();
      });

      // Line 1: star? · title · phase pill · right (model · elapsed · cost)
      const line1 = el('div', { class: 'fleet-line1' });
      if (t.blockedOn !== null) {
        const star = el('span', { class: 'star', title: 'Answer in the inbox' }, '★');
        star.addEventListener('click', (e) => {
          e.stopPropagation();
          ctx.switchTab('inbox', t.blockedOn ?? undefined);
        });
        line1.append(star);
      }
      line1.append(el('span', { class: 'fleet-title' }, t.spec.title));
      line1.append(el('span', { class: ('pill ' + pillClass(t.phase)).trim() }, PHASE_LABEL[t.phase]));

      const right = el('div', { class: 'fleet-right' });
      right.append(el('span', { class: 'fleet-model' }, modelShort(t.spec.model)));
      const ems = elapsedMs(t, ctx.now());
      if (ems !== null) right.append(el('span', { class: 'fleet-num' }, fmtDuration(ems)));
      right.append(el('span', { class: 'fleet-num' }, fmtCost(t.costUsd)));
      line1.append(right);
      c.append(line1);

      // Blocked: the whole point of the product — make the wait impossible to miss.
      if (t.blockedOn !== null) {
        let ms = 0;
        if (t.blockedSince !== null) {
          const b = Date.parse(t.blockedSince);
          if (!Number.isNaN(b)) ms = Math.max(0, ctx.now() - b);
        }
        c.append(el('div', { class: 'fleet-waiting' }, `★ Waiting on you — ${fmtDuration(ms)}`));
      }

      // Progress: a real bar only with steps; otherwise a subtle activity line.
      if (t.stepsDone !== null && t.stepsTotal !== null && t.stepsTotal > 0) {
        const pct = Math.max(0, Math.min(100, (t.stepsDone / t.stepsTotal) * 100));
        const fill = el('div', { class: 'fleet-fill' });
        fill.style.width = `${pct}%`;
        c.append(
          el(
            'div',
            { class: 'fleet-progress' },
            el('div', { class: 'fleet-track' }, fill),
            el('span', { class: 'fleet-steplabel' }, `step ${t.stepsDone} of ${t.stepsTotal}`),
          ),
        );
      } else {
        const text = activityText(t);
        if (text.length > 0) {
          const isCode = t.lastActivity !== null && t.lastActivity.length > 0;
          const dot = el('div', { class: 'fleet-dot' + (t.phase === 'RUNNING' ? ' pulse' : '') });
          const label = el(
            'div',
            { class: 'fleet-activity-text' + (isCode ? ' mono' : ''), title: text },
            text,
          );
          c.append(el('div', { class: 'fleet-activity' }, dot, label));
        }
      }

      // Meta: scope · files touched · escalations · failure reason.
      const meta = el('div', { class: 'fleet-meta' });
      const globs = t.spec.scope.include;
      if (globs.length > 0) {
        const joined = globs.join(' · ');
        meta.append(el('span', { class: 'fleet-scope mono', title: joined }, joined));
      } else {
        meta.append(el('span', {}, 'No write scope — every write asks you first'));
      }
      if (t.writes.length > 0) {
        meta.append(sep(), el('span', {}, `${t.writes.length} ${t.writes.length === 1 ? 'file' : 'files'} touched`));
      }
      if (t.escalations > 0) {
        meta.append(sep(), el('span', {}, `${t.escalations} escalation${t.escalations === 1 ? '' : 's'}`));
      }
      if ((t.phase === 'FAILED' || t.phase === 'CANCELLED') && t.failureReason !== null) {
        meta.append(sep(), el('span', { class: 'fleet-fail' }, t.failureReason));
      }
      c.append(meta);

      if (expanded) c.append(expandSection(t));
      return c;
    };

    // ---- expanded card body ------------------------------------------------
    const expandSection = (t: Task): HTMLElement => {
      const sec = el('div', { class: 'fleet-expand' });
      sec.addEventListener('click', (e) => e.stopPropagation());

      const tail = el('div', { class: 'fleet-tail' });
      if (t.recentToolCalls.length === 0) {
        tail.append(el('div', { class: 'fleet-tail-empty' }, 'No tool calls yet.'));
      } else {
        for (const tc of t.recentToolCalls) {
          tail.append(el('div', { class: 'fleet-tail-line mono' }, `${fmtClock(tc.ts)}  ${tc.detail}`));
        }
      }
      sec.append(tail);

      const steerOpen = recMap<boolean>(vs, 'steerOpen');
      const steerText = recMap<string>(vs, 'steerText');
      const live = LIVE_PHASES.includes(t.phase);
      const canSteer = t.phase === 'RUNNING' || t.phase === 'BLOCKED';

      const sendSteer = (): void => {
        const msg = (steerText[t.spec.id] ?? '').trim();
        if (msg.length === 0) return;
        ctx.send({ kind: 'steer', taskId: t.spec.id, message: msg });
        steerText[t.spec.id] = '';
        steerOpen[t.spec.id] = false;
        rerender();
      };

      const actions = el('div', { class: 'fleet-actions-row' });
      if (canSteer) {
        actions.append(
          btn('Steer', () => {
            steerOpen[t.spec.id] = !steerOpen[t.spec.id];
            rerender();
          }),
        );
      }
      // QUEUED tasks are cancellable too — waiting is not a commitment (C14).
      if (live || t.phase === 'QUEUED') {
        actions.append(btn(t.phase === 'QUEUED' ? 'Cancel' : 'Stop', () => ctx.send({ kind: 'stop-task', taskId: t.spec.id }), 'danger'));
      }
      // worktreePath goes null when the merge tears the worktree down (C12) —
      // both buttons act on the directory, so both gate on it.
      if (t.worktreePath !== null) {
        actions.append(btn('Open worktree', () => ctx.send({ kind: 'open-worktree', taskId: t.spec.id })));
        actions.append(btn('View diff', () => ctx.send({ kind: 'view-diff', taskId: t.spec.id })));
      }
      if (t.phase === 'READY') actions.append(btn('Merge now', () => ctx.send({ kind: 'merge-task', taskId: t.spec.id })));
      sec.append(actions);

      if (canSteer && steerOpen[t.spec.id] === true) {
        const inp = el('input', {
          type: 'text',
          'data-fkey': 'steer-' + t.spec.id,
          placeholder: 'Send a note to steer this agent…',
        }) as HTMLInputElement;
        inp.value = steerText[t.spec.id] ?? '';
        inp.addEventListener('click', (e) => e.stopPropagation());
        inp.addEventListener('input', () => {
          steerText[t.spec.id] = inp.value;
        });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            sendSteer();
          }
        });
        sec.append(el('div', { class: 'fleet-steer' }, inp, btn('Send', () => sendSteer(), 'primary')));
      }
      return sec;
    };

    // ---- new-task composer -------------------------------------------------
    const textInput = (fkey: string, value: string, placeholder: string): HTMLInputElement => {
      const i = el('input', { type: 'text', 'data-fkey': fkey, placeholder }) as HTMLInputElement;
      i.value = value;
      i.addEventListener('click', (e) => e.stopPropagation());
      return i;
    };
    const numInput = (fkey: string, value: string, placeholder: string): HTMLInputElement => {
      const i = el('input', { type: 'number', 'data-fkey': fkey, placeholder }) as HTMLInputElement;
      i.value = value;
      i.addEventListener('click', (e) => e.stopPropagation());
      return i;
    };
    const textArea = (fkey: string, value: string, placeholder: string): HTMLTextAreaElement => {
      const t = el('textarea', { 'data-fkey': fkey, placeholder }) as HTMLTextAreaElement;
      t.value = value;
      t.addEventListener('click', (e) => e.stopPropagation());
      return t;
    };
    const buildSelect = (
      fkey: string,
      options: ReadonlyArray<readonly [string, string]>,
      current: string,
      onChange: (v: string) => void,
    ): HTMLSelectElement => {
      const s = el('select', { 'data-fkey': fkey }) as HTMLSelectElement;
      for (const [val, lbl] of options) s.append(el('option', { value: val }, lbl));
      if (!options.some(([v]) => v === current)) s.append(el('option', { value: current }, current));
      s.value = current;
      s.addEventListener('click', (e) => e.stopPropagation());
      s.addEventListener('change', () => onChange(s.value));
      return s;
    };
    const field = (
      labelText: string,
      control: HTMLElement,
      hint?: string,
      error?: string,
    ): HTMLElement => {
      const parts: (Node | string)[] = [el('label', {}, labelText), control];
      if (hint !== undefined) parts.push(el('div', { class: 'hint' }, hint));
      if (error !== undefined) parts.push(el('div', { class: 'fleet-error' }, error));
      return el('div', { class: 'field' }, ...parts);
    };

    const submitComposer = (): void => {
      const d = getDraft(vs, cfg);
      const errs: ComposerErrors = {};
      const title = d.title.trim();
      if (title.length === 0) errs.title = 'Give the task a title.';
      const id = (d.idEdited ? d.id : slugify(d.title)).trim();
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
        errs.id = 'Use lowercase letters, numbers, and hyphens, starting with a letter or number.';
      } else if (state.tasks[id] !== undefined) {
        errs.id = 'A task with this id already exists.';
      }
      const prompt = d.prompt.trim();
      if (prompt.length === 0) errs.prompt = 'Write the prompt this agent should run.';

      if (errs.title !== undefined || errs.id !== undefined || errs.prompt !== undefined) {
        vs['cerrors'] = errs;
        rerender();
        return;
      }

      const globs = d.scope
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const budgetRaw = d.budget.trim();
      const budgetNum = budgetRaw === '' ? null : Number(budgetRaw);
      const budgetUsd = budgetNum !== null && Number.isFinite(budgetNum) && budgetNum > 0 ? budgetNum : null;
      const verify = d.verify.trim();

      const spec: TaskSpec = {
        id,
        title,
        prompt,
        scope: { include: globs },
        model: d.model as ModelId,
        effort: d.effort as Effort,
        gates: verify.length > 0 ? [{ name: 'verify', command: verify }] : [],
        budgetUsd,
        autoMerge: d.autoMerge,
      };
      ctx.send({ kind: 'create-task', spec });
      vs['draft'] = seedDraft(cfg);
      vs['cerrors'] = undefined;
      vs['composer'] = false;
      rerender();
    };

    const composer = (): HTMLElement => {
      const d = getDraft(vs, cfg);
      const errs = (vs['cerrors'] as ComposerErrors | undefined) ?? {};

      const overlay = el('div', { class: 'fleet-overlay' });
      overlay.addEventListener('click', () => closeComposer());
      const box = el('div', { class: 'fleet-composer' });
      box.addEventListener('click', (e) => e.stopPropagation());
      box.append(el('h2', {}, 'New task'));

      const titleInput = textInput('c-title', d.title, 'e.g. Add invoice PDF export');
      const idInput = textInput('c-id', d.idEdited ? d.id : slugify(d.title), '');
      titleInput.addEventListener('input', () => {
        d.title = titleInput.value;
        if (!d.idEdited) {
          d.id = slugify(d.title);
          idInput.value = d.id;
        }
      });
      idInput.addEventListener('input', () => {
        d.idEdited = true;
        d.id = idInput.value;
      });
      box.append(field('Title', titleInput, undefined, errs.title));
      box.append(field('Id', idInput, 'A unique slug for the branch and worktree.', errs.id));

      const promptTa = textArea('c-prompt', d.prompt, 'What should this agent do? Be specific about the goal and the constraints.');
      promptTa.addEventListener('input', () => {
        d.prompt = promptTa.value;
      });
      box.append(field('Prompt', promptTa, undefined, errs.prompt));

      const scopeTa = textArea('c-scope', d.scope, 'src/billing/**');
      scopeTa.addEventListener('input', () => {
        d.scope = scopeTa.value;
      });
      box.append(
        field(
          'Scope',
          scopeTa,
          'Paths this task may edit, one glob per line, e.g. src/billing/** — anything else asks you first.',
        ),
      );

      const modelSel = buildSelect('c-model', MODEL_OPTIONS, d.model, (v) => {
        d.model = v;
      });
      const effortSel = buildSelect('c-effort', EFFORT_OPTIONS, d.effort, (v) => {
        d.effort = v;
      });
      box.append(el('div', { class: 'fleet-row2' }, field('Model', modelSel), field('Effort', effortSel)));

      const verifyInput = textInput('c-verify', d.verify, 'e.g. npm test');
      verifyInput.addEventListener('input', () => {
        d.verify = verifyInput.value;
      });
      box.append(
        field('Verify command', verifyInput, 'Optional. Must exit 0 in the worktree before this task can merge.'),
      );

      const budgetInput = numInput('c-budget', d.budget, 'e.g. 10');
      budgetInput.addEventListener('input', () => {
        d.budget = budgetInput.value;
      });
      box.append(field('Budget (USD)', budgetInput, 'Optional spend cap. Leave empty for no cap.'));

      const chk = el('input', { type: 'checkbox', 'data-fkey': 'c-automerge' }) as HTMLInputElement;
      chk.checked = d.autoMerge;
      chk.addEventListener('click', (e) => e.stopPropagation());
      chk.addEventListener('change', () => {
        d.autoMerge = chk.checked;
      });
      box.append(
        el(
          'div',
          { class: 'field fleet-checkbox' },
          chk,
          el('label', {}, 'Enter the merge queue automatically when ready'),
        ),
      );

      const create = el('button', { class: 'btn primary' }, 'Create');
      create.addEventListener('click', () => submitComposer());
      const cancel = el('button', { class: 'btn' }, 'Cancel');
      cancel.addEventListener('click', () => closeComposer());
      box.append(el('div', { class: 'fleet-composer-actions' }, cancel, create));

      overlay.append(box);
      return overlay;
    };

    // ---- empty state -------------------------------------------------------
    const emptyState = (): HTMLElement => {
      const box = el(
        'div',
        { class: 'empty' },
        el('h2', {}, 'No tasks yet'),
        el(
          'p',
          {},
          'A task is a scoped prompt run by its own agent in its own git worktree. Create one and watch it work here.',
        ),
      );
      const b = el('button', { class: 'btn primary' }, 'New task');
      b.addEventListener('click', () => openComposer());
      box.append(b);
      return box;
    };

    // ---- assemble ----------------------------------------------------------
    function build(): void {
      if (state.taskOrder.length === 0) {
        root.append(emptyState());
      } else {
        root.append(header());
        for (const id of state.taskOrder) {
          const t = state.tasks[id];
          if (t !== undefined) root.append(card(t));
        }
      }
      if (vs['composer'] === true) root.append(composer());
      scheduleRestore();
    }

    build();
  },

  onKey(e: KeyboardEvent, _state: FleetState, ctx: TabContext): boolean {
    const vs = ctx.viewState;
    const composerOpen = vs['composer'] === true;
    if (e.key === 'Escape') {
      if (composerOpen) {
        vs['composer'] = false;
        vs['cerrors'] = undefined;
        ctx.switchTab('fleet');
        return true;
      }
      return false;
    }
    if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !composerOpen) {
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      const inField =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tgt?.isContentEditable === true;
      if (!inField) {
        vs['composer'] = true;
        vs['fkey'] = 'c-title';
        ctx.switchTab('fleet');
        return true;
      }
    }
    return false;
  },
};
