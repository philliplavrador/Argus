/**
 * Settings tab — a working copy of FleetState.config, edited in a ~640px form
 * and written back with a single `set-config` intent. The system-prompt
 * preview shows exactly what these settings append to every agent, so nothing
 * about them is magic. The draft lives in ctx.viewState; render is idempotent
 * and rebuilt from scratch on every tick, matching main.ts's loop.
 */

import { buildSystemPromptAppend } from '../../core/prompt';
import type {
  ArgusConfig,
  Effort,
  FleetState,
  ModelId,
  Pushback,
  TaskSpec,
  Verbosity,
} from '../../core/types';
import { el } from '../dom';
import type { Tab, TabContext } from './tab';

const DRAFT_KEY = 'draft';

const MODELS: { id: ModelId; label: string }[] = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Maximum' },
];

const VERBOSITY_OPTS: { id: Verbosity; name: string; desc: string }[] = [
  { id: 'terse', name: 'Terse', desc: 'Single-line progress, no narration.' },
  { id: 'normal', name: 'Normal', desc: 'Brief notes at meaningful milestones.' },
  { id: 'detailed', name: 'Detailed', desc: 'Plans, notable decisions, and a summary per step.' },
];

const PUSHBACK_OPTS: { id: Pushback; name: string; desc: string }[] = [
  { id: 'autonomous', name: 'Autonomous', desc: 'Decides on its own; asks only when a choice is irreversible.' },
  { id: 'balanced', name: 'Balanced', desc: 'Asks when a decision materially shapes the outcome.' },
  { id: 'consult', name: 'Consult', desc: 'Asks before each significant decision and any destructive step.' },
];

/** Deep clone that survives the JSON round-trip config already lives through. */
function clone(c: ArgusConfig): ArgusConfig {
  return JSON.parse(JSON.stringify(c)) as ArgusConfig;
}

/** The literal example spec whose appended prompt the preview renders. */
function sampleSpec(d: ArgusConfig): TaskSpec {
  return {
    id: 'sample-task',
    title: 'Example task',
    prompt: '',
    scope: { include: ['src/billing/**'] },
    model: d.defaultModel,
    effort: d.defaultEffort,
    gates: [],
    budgetUsd: null,
    autoMerge: false,
  };
}

/** Clamp/coerce a draft into a valid config for saving. */
function normalize(d: ArgusConfig): ArgusConfig {
  const clampConcurrency = (n: number): number => {
    const r = Math.round(n);
    if (!Number.isFinite(r)) {
      return 4;
    }
    return Math.min(8, Math.max(1, r));
  };
  const budget = (n: number | null): number | null => {
    if (n === null || !Number.isFinite(n)) {
      return null;
    }
    return Math.max(0, n);
  };
  const verify = d.verifyCommand === null ? null : d.verifyCommand.trim();
  return {
    maxConcurrentAgents: clampConcurrency(d.maxConcurrentAgents),
    defaultModel: d.defaultModel,
    defaultEffort: d.defaultEffort,
    verbosity: d.verbosity,
    pushback: d.pushback,
    perTaskBudgetUsd: budget(d.perTaskBudgetUsd),
    fleetBudgetUsd: budget(d.fleetBudgetUsd),
    autoMerge: d.autoMerge,
    verifyCommand: verify === '' ? null : verify,
    installDepsOnProvision: d.installDepsOnProvision,
  };
}

/** A small uppercase section heading + its card of fields. */
function section(title: string, ...cardChildren: (Node | string | null)[]): HTMLElement {
  return el(
    'section',
    { class: 'settings-section' },
    el('h3', { class: 'settings-head' }, title),
    el('div', { class: 'card settings-card' }, ...cardChildren),
  );
}

export const settingsTab: Tab = {
  id: 'settings',
  label: () => 'Settings',
  render(root: HTMLElement, state: FleetState, ctx: TabContext): void {
    // Working copy: seed from committed config once, then persist across renders.
    let draft = ctx.viewState[DRAFT_KEY] as ArgusConfig | undefined;
    if (draft === undefined) {
      draft = clone(state.config);
      ctx.viewState[DRAFT_KEY] = draft;
    }

    build();

    function build(): void {
      const d = ctx.viewState[DRAFT_KEY] as ArgusConfig;

      // --- Live regions updated in-place so keystrokes never lose focus. ---
      const preview = el('pre', { class: 'prompt-preview mono' });
      const dirtyFlag = el('span', { class: 'dirty-flag' }, 'Unsaved changes');
      const saveBtn = el('button', { class: 'btn primary' }, 'Save settings') as HTMLButtonElement;

      const sync = (): void => {
        preview.textContent = buildSystemPromptAppend(sampleSpec(d), d);
        const dirty = JSON.stringify(d) !== JSON.stringify(state.config);
        dirtyFlag.hidden = !dirty;
        saveBtn.disabled = !dirty;
      };

      // ---- FLEET --------------------------------------------------------
      const concurrency = el('input', {
        type: 'number',
        id: 'set-concurrency',
        value: Number.isFinite(d.maxConcurrentAgents) ? String(d.maxConcurrentAgents) : '',
      }) as HTMLInputElement;
      concurrency.min = '1';
      concurrency.max = '8';
      concurrency.step = '1';
      concurrency.addEventListener('input', () => {
        const v = concurrency.value.trim();
        d.maxConcurrentAgents = v === '' ? NaN : parseInt(v, 10);
        sync();
      });

      const modelSel = el('select', { id: 'set-model' }) as HTMLSelectElement;
      for (const m of MODELS) {
        modelSel.append(el('option', { value: m.id }, m.label));
      }
      modelSel.value = d.defaultModel;
      modelSel.addEventListener('change', () => {
        d.defaultModel = modelSel.value;
        sync();
      });

      const effortSel = el('select', { id: 'set-effort' }) as HTMLSelectElement;
      for (const e of EFFORTS) {
        effortSel.append(el('option', { value: e.id }, e.label));
      }
      effortSel.value = d.defaultEffort;
      effortSel.addEventListener('change', () => {
        d.defaultEffort = effortSel.value as Effort;
        sync();
      });

      const fleet = section(
        'Fleet',
        field('set-concurrency', 'Max concurrent agents', concurrency, [
          '1 to 8. Spike A measured 8 agents running clean; the default is 4.',
        ]),
        field('set-model', 'Default model', modelSel),
        field('set-effort', 'Default effort', effortSel),
      );

      // ---- BEHAVIOR -----------------------------------------------------
      const behavior = section(
        'Behavior',
        el('div', { class: 'field' },
          el('label', {}, 'Verbosity'),
          radioList('verbosity', VERBOSITY_OPTS, d.verbosity, (v) => {
            d.verbosity = v;
            sync();
          }),
        ),
        el('div', { class: 'field' },
          el('label', {}, 'Pushback'),
          radioList('pushback', PUSHBACK_OPTS, d.pushback, (v) => {
            d.pushback = v;
            sync();
          }),
          el(
            'div',
            { class: 'hint' },
            "Dual control: this changes both the agent's instructions AND what the permission layer escalates — balanced and consult route risky shell commands to your inbox.",
          ),
        ),
      );

      // ---- BUDGETS ------------------------------------------------------
      const perTask = budgetInput('set-pertask', d.perTaskBudgetUsd, (n) => {
        d.perTaskBudgetUsd = n;
        sync();
      });
      const fleetBudget = budgetInput('set-fleet', d.fleetBudgetUsd, (n) => {
        d.fleetBudgetUsd = n;
        sync();
      });
      const budgets = section(
        'Budgets',
        field('set-pertask', 'Per-task budget (USD)', perTask, undefined, true),
        field('set-fleet', 'Fleet budget (USD)', fleetBudget, undefined, true),
        el('div', { class: 'hint' }, 'Client-side estimates; the fleet stops when the cap is crossed.'),
      );

      // ---- MERGE & VERIFY ----------------------------------------------
      const autoMerge = checkbox(
        'set-automerge',
        'Merge tasks automatically when their gates pass',
        d.autoMerge,
        (v) => {
          d.autoMerge = v;
          sync();
        },
      );

      const verifyCmd = el('input', {
        type: 'text',
        id: 'set-verify',
        value: d.verifyCommand ?? '',
        placeholder: 'e.g. npm test',
      }) as HTMLInputElement;
      verifyCmd.addEventListener('input', () => {
        d.verifyCommand = verifyCmd.value === '' ? null : verifyCmd.value;
        sync();
      });

      const installDeps = checkbox(
        'set-installdeps',
        'Install dependencies in new worktrees',
        d.installDepsOnProvision,
        (v) => {
          d.installDepsOnProvision = v;
          sync();
        },
        ['About 7 seconds per task on a warm npm cache.'],
      );

      const mergeVerify = section(
        'Merge and verify',
        autoMerge,
        el('div', { class: 'field' },
          el('label', { for: 'set-verify' }, 'Verify command'),
          verifyCmd,
          el(
            'div',
            { class: 'hint' },
            'Runs in each worktree before merge when a task declares no gates, for example ',
            el('code', {}, 'npm test'),
            '.',
          ),
        ),
        installDeps,
      );

      // ---- SYSTEM PROMPT PREVIEW ---------------------------------------
      const promptSection = section(
        'System prompt preview',
        preview,
        el(
          'div',
          { class: 'caption' },
          "Exactly what gets appended to every agent's system prompt with these settings — settings are never magic.",
        ),
      );

      // ---- WORKSPACE ----------------------------------------------------
      const initBtn = el('button', { class: 'btn' }, 'Initialize .argus in this repo');
      initBtn.addEventListener('click', () => ctx.send({ kind: 'init-workspace' }));
      const cleanupBtn = el('button', { class: 'btn' }, 'Clean up stale worktrees');
      cleanupBtn.addEventListener('click', () => ctx.send({ kind: 'cleanup-worktrees' }));

      const workspace = section(
        'Workspace',
        el('div', { class: 'workspace-action' },
          initBtn,
          el('div', { class: 'hint' }, 'Idempotent — safe to run again; it also updates .gitignore.'),
        ),
        el('div', { class: 'workspace-action' },
          cleanupBtn,
          el('div', { class: 'hint' }, 'Removes worktrees left behind by finished or abandoned tasks.'),
        ),
      );

      // ---- FOOTER -------------------------------------------------------
      saveBtn.addEventListener('click', () => {
        const normalized = normalize(d);
        ctx.send({ kind: 'set-config', config: normalized });
        // Reconcile the draft to what we sent so the host echo lands clean.
        ctx.viewState[DRAFT_KEY] = clone(normalized);
        build();
      });
      const revertBtn = el('button', { class: 'btn' }, 'Revert');
      revertBtn.addEventListener('click', () => {
        ctx.viewState[DRAFT_KEY] = clone(state.config);
        build();
      });

      const footer = el(
        'div',
        { class: 'settings-footer' },
        saveBtn,
        revertBtn,
        dirtyFlag,
      );

      root.replaceChildren(
        el(
          'form',
          { class: 'settings-form' },
          fleet,
          behavior,
          budgets,
          mergeVerify,
          promptSection,
          workspace,
          footer,
        ),
      );

      sync();
    }
  },
};

/** A labelled field wrapper. `narrow` caps input width for small numbers. */
function field(
  forId: string,
  labelText: string,
  control: HTMLElement,
  hints?: string[],
  narrow = false,
): HTMLElement {
  const children: (Node | string)[] = [el('label', { for: forId }, labelText), control];
  if (hints !== undefined) {
    for (const h of hints) {
      children.push(el('div', { class: 'hint' }, h));
    }
  }
  return el('div', { class: `field${narrow ? ' narrow' : ''}` }, ...children);
}

/** A vertical list of selectable radio rows with one-line explanations. */
function radioList<T extends string>(
  group: string,
  opts: { id: T; name: string; desc: string }[],
  current: T,
  onPick: (v: T) => void,
): HTMLElement {
  const list = el('div', { class: 'opt-list' });
  for (const o of opts) {
    const input = el('input', { type: 'radio', name: group, id: `${group}-${o.id}` }) as HTMLInputElement;
    input.checked = o.id === current;
    input.addEventListener('change', () => {
      if (input.checked) {
        onPick(o.id);
      }
    });
    list.append(
      el(
        'label',
        { class: 'opt', for: `${group}-${o.id}` },
        input,
        el('span', { class: 'opt-body' },
          el('span', { class: 'opt-name' }, o.name),
          el('span', { class: 'opt-desc' }, o.desc),
        ),
      ),
    );
  }
  return list;
}

/** A checkbox row with an optional hint underneath. */
function checkbox(
  id: string,
  labelText: string,
  checked: boolean,
  onToggle: (v: boolean) => void,
  hints?: string[],
): HTMLElement {
  const input = el('input', { type: 'checkbox', id }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener('change', () => onToggle(input.checked));
  const row = el(
    'label',
    { class: 'check', for: id },
    input,
    el('span', { class: 'check-label' }, labelText),
  );
  const children: (Node | string)[] = [row];
  if (hints !== undefined) {
    for (const h of hints) {
      children.push(el('div', { class: 'hint check-hint' }, h));
    }
  }
  return el('div', { class: 'field' }, ...children);
}

/** A budget number input: empty string means "no limit" (null). */
function budgetInput(
  id: string,
  value: number | null,
  onChange: (n: number | null) => void,
): HTMLInputElement {
  const input = el('input', {
    type: 'number',
    id,
    value: value === null ? '' : String(value),
    placeholder: 'No limit',
  }) as HTMLInputElement;
  input.min = '0';
  input.step = '0.01';
  input.addEventListener('input', () => {
    const v = input.value.trim();
    onChange(v === '' ? null : parseFloat(v));
  });
  return input;
}
