/**
 * Timeline tab — the append-only event log made visible. This is the
 * debugging surface that justifies keeping every state change as an event:
 * a chronological, filterable stream of what the fleet actually did.
 *
 * The tab holds no DOM state between renders (main.ts re-renders it from
 * scratch on every event and every 1s tick). All view state — filters, the
 * follow toggle, scroll position — lives on ctx.viewState.
 */

import type {
  ArgusEvent,
  FleetState,
  InboxResolution,
  TaskId,
} from '../../core/types';
import { el, fmtClock, fmtCost } from '../dom';
import type { Tab, TabContext } from './tab';

// ---------------------------------------------------------------------------
// View-state keys (all namespaced so they can't collide on ctx.viewState)
// ---------------------------------------------------------------------------

const K_REQUESTED = 'tl_requested';
const K_TASK = 'tl_task';
const K_LIFE = 'tl_lifecycle';
const K_DEC = 'tl_decisions';
const K_TOOLS = 'tl_tools';
const K_TEXT = 'tl_text';
const K_FOLLOW = 'tl_follow';
const K_SCROLL = 'tl_scroll';

/** Only ever render the most recent N matching rows, for safety. */
const RENDER_CAP = 400;
/** Past this many pixels from the bottom, a manual scroll disables Follow. */
const FOLLOW_SLOP = 40;

// ---------------------------------------------------------------------------
// Event classification (matches the four control checkboxes)
// ---------------------------------------------------------------------------

type EventClass = 'lifecycle' | 'decisions' | 'tools' | 'text' | 'other';

const LIFECYCLE = new Set<string>([
  'orchestrator-started',
  'config-changed',
  'task-created',
  'task-queued',
  'task-started',
  'agent-init',
  'task-blocked',
  'task-resumed',
  'task-verifying',
  'gate-finished',
  'task-ready',
  'merge-started',
  'merge-finished',
  'task-failed',
  'task-cancelled',
  'task-steered',
]);
const DECISIONS = new Set<string>(['inbox-raised', 'inbox-resolved', 'scope-expanded']);
const TOOLS = new Set<string>(['tool-call', 'path-write', 'path-read']);
const TEXT = new Set<string>(['agent-text', 'usage', 'progress']);

function classify(type: string): EventClass {
  if (LIFECYCLE.has(type)) {
    return 'lifecycle';
  }
  if (DECISIONS.has(type)) {
    return 'decisions';
  }
  if (TOOLS.has(type)) {
    return 'tools';
  }
  if (TEXT.has(type)) {
    return 'text';
  }
  return 'other';
}

/** The task an event belongs to, or null for fleet-wide events. */
function eventTaskId(e: ArgusEvent): TaskId | null {
  if (e.type === 'inbox-raised') {
    return e.item.taskId;
  }
  if (e.type === 'inbox-resolved') {
    return e.itemId.split('#')[0] || null;
  }
  if ('taskId' in e) {
    return (e as { taskId: TaskId }).taskId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stable per-task chip hue (hash the id into 8 CSS-defined color pairs)
// ---------------------------------------------------------------------------

function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return h % 8;
}

// ---------------------------------------------------------------------------
// Per-event human summary
// ---------------------------------------------------------------------------

interface Summary {
  icon: string;
  /** Render the icon as the one loud accent glyph (task-blocked only). */
  star?: boolean;
  /** Success/danger text tint for the summary line. */
  tint?: 'ok' | 'bad';
  nodes: (Node | string)[];
}

function mono(text: string): HTMLElement {
  return el('span', { class: 'mono' }, text);
}

function resolutionNodes(res: InboxResolution): (Node | string)[] {
  switch (res.rkind) {
    case 'question': {
      const parts: (Node | string)[] = [];
      if (res.optionLabels.length > 0) {
        parts.push(res.optionLabels.join(', '));
      }
      if (res.freeText) {
        parts.push(`“${res.freeText}”`);
      }
      return parts.length > 0 ? parts : ['(no answer)'];
    }
    case 'scope-escalation': {
      if (res.action === 'allow-once') {
        return ['allowed once'];
      }
      if (res.action === 'expand-scope') {
        return ['expanded scope + ', mono(res.glob)];
      }
      return [res.reason ? `denied: ${res.reason}` : 'denied'];
    }
    case 'verify-failure': {
      if (res.action === 'send-back') {
        return [res.note ? `sent back: ${res.note}` : 'sent back'];
      }
      if (res.action === 'override') {
        return ['overridden'];
      }
      return ['abandoned'];
    }
    case 'merge-conflict': {
      if (res.action === 'agent-fix') {
        return ['agent fixing'];
      }
      if (res.action === 'open-editor') {
        return ['opened in editor'];
      }
      return ['abandoned'];
    }
  }
}

function summarize(e: ArgusEvent): Summary {
  switch (e.type) {
    case 'orchestrator-started':
      return { icon: '⦿', nodes: [`orchestrator started (v${e.version})`] };
    case 'config-changed':
      return { icon: '◇', nodes: ['configuration changed'] };
    case 'task-created':
      return { icon: '+', nodes: ['created — ', e.spec.title] };
    case 'task-queued':
      return { icon: '•', nodes: ['queued'] };
    case 'task-started':
      return { icon: '▸', nodes: ['started in ', mono(e.branch)] };
    case 'agent-init':
      return {
        icon: '◆',
        nodes: ['session ', mono(e.sessionId.slice(0, 8)), `… on ${e.model}`],
      };
    case 'task-blocked':
      return { icon: '★', star: true, nodes: ['waiting on ', mono(e.itemId)] };
    case 'task-resumed':
      return { icon: '▸', nodes: ['resumed'] };
    case 'task-verifying':
      return { icon: '↻', nodes: ['verifying'] };
    case 'gate-finished': {
      const ok = e.result.exitCode === 0;
      return {
        icon: ok ? '✓' : '✕',
        tint: ok ? 'ok' : 'bad',
        nodes: [`gate ${e.result.name}: exit ${e.result.exitCode}`],
      };
    }
    case 'task-ready':
      return { icon: '◉', tint: 'ok', nodes: ['ready to merge'] };
    case 'merge-started':
      return { icon: '↦', nodes: ['merging…'] };
    case 'merge-finished':
      return {
        icon: '✓',
        tint: 'ok',
        nodes: ['merged ', mono(e.mergeCommit.slice(0, 7))],
      };
    case 'task-failed':
      return { icon: '✕', tint: 'bad', nodes: [`failed — ${e.reason}`] };
    case 'task-cancelled':
      return {
        icon: '⊘',
        nodes: [e.reason ? `cancelled — ${e.reason}` : 'cancelled'],
      };
    case 'task-steered':
      return { icon: '»', nodes: [`steered: ${e.message}`] };
    case 'tool-call':
      return { icon: '›', nodes: [mono(e.detail)] };
    case 'path-write':
      return { icon: '+', nodes: [mono(`+${e.path}`)] };
    case 'path-read':
      return { icon: '·', nodes: [mono(e.path)] };
    case 'inbox-raised':
      return { icon: '◈', nodes: [`${e.item.kind.replace(/-/g, ' ')} raised`] };
    case 'inbox-resolved':
      return { icon: '✓', nodes: ['answered: ', ...resolutionNodes(e.resolution)] };
    case 'scope-expanded':
      return { icon: '⊕', nodes: ['scope + ', mono(e.glob)] };
    case 'agent-text':
      return { icon: '“', nodes: [el('span', { class: 'tl-quiet' }, e.text)] };
    case 'usage':
      return { icon: '$', nodes: [`+${fmtCost(e.costUsdDelta)}`] };
    case 'progress':
      return { icon: '∷', nodes: [`step ${e.stepsDone}/${e.stepsTotal}`] };
    default:
      // Forward compatibility: an event type this build doesn't know about.
      return { icon: '·', nodes: [el('span', { class: 'tl-quiet' }, (e as { type: string }).type)] };
  }
}

// ---------------------------------------------------------------------------
// Small typed viewState readers
// ---------------------------------------------------------------------------

function vsBool(vs: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = vs[key];
  return typeof v === 'boolean' ? v : def;
}
function vsStr(vs: Record<string, unknown>, key: string, def: string): string {
  const v = vs[key];
  return typeof v === 'string' ? v : def;
}
function vsNum(vs: Record<string, unknown>, key: string, def: number): number {
  const v = vs[key];
  return typeof v === 'number' ? v : def;
}

// ---------------------------------------------------------------------------
// Row + chip construction
// ---------------------------------------------------------------------------

function chipEl(taskId: TaskId, state: FleetState): HTMLElement {
  const title = state.tasks[taskId]?.spec.title ?? taskId;
  return el(
    'span',
    { class: `tl-chip h${hueOf(taskId)}`, title },
    el('span', { class: 'tl-dot' }),
    el('span', { class: 'tl-chip-id' }, taskId),
  );
}

function fleetChipEl(): HTMLElement {
  return el(
    'span',
    { class: 'tl-chip tl-chip-fleet', title: 'Fleet-wide event' },
    el('span', { class: 'tl-dot' }),
    el('span', { class: 'tl-chip-id' }, 'fleet'),
  );
}

function rowEl(e: ArgusEvent, state: FleetState): HTMLElement {
  const tid = eventTaskId(e);
  const s = summarize(e);
  const iconClass = `tl-icon${s.star ? ' tl-star' : ''}`;
  const summaryClass = `tl-summary${s.tint ? ` tl-${s.tint}` : ''}`;
  return el(
    'div',
    { class: 'tl-row' },
    el('span', { class: 'tl-time mono' }, fmtClock(e.ts)),
    el('span', { class: 'tl-sep' }, '·'),
    tid !== null ? chipEl(tid, state) : fleetChipEl(),
    el('span', { class: 'tl-sep' }, '·'),
    el('span', { class: iconClass }, s.icon),
    el('span', { class: summaryClass }, ...s.nodes),
  );
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export const timelineTab: Tab = {
  id: 'timeline',
  label: () => 'Timeline',
  render(root: HTMLElement, state: FleetState, ctx: TabContext): void {
    const history = ctx.history();

    // First visit with an empty buffer: ask the host for the log once and show
    // a quiet placeholder. A 'history' message re-renders us shortly.
    if (history.length === 0 && !vsBool(ctx.viewState, K_REQUESTED, false)) {
      ctx.viewState[K_REQUESTED] = true;
      ctx.requestHistory();
      root.append(el('div', { class: 'tl-loading' }, 'Loading history…'));
      return;
    }

    // Backfill has run and there is still nothing: the genuine empty state.
    if (history.length === 0) {
      root.append(
        el(
          'div',
          { class: 'empty' },
          el('h2', {}, 'No events yet'),
          el(
            'p',
            {},
            'Argus records every state change to an append-only log at ',
          ),
          el('p', {}, el('span', { class: 'mono' }, '.argus/state/events.jsonl')),
          el('p', {}, 'This timeline fills the moment a task starts running.'),
        ),
      );
      return;
    }

    const build = (): void => {
      root.replaceChildren();

      const taskFilter = vsStr(ctx.viewState, K_TASK, 'all');
      const showLife = vsBool(ctx.viewState, K_LIFE, true);
      const showDec = vsBool(ctx.viewState, K_DEC, true);
      const showTools = vsBool(ctx.viewState, K_TOOLS, false);
      const showText = vsBool(ctx.viewState, K_TEXT, false);
      const follow = vsBool(ctx.viewState, K_FOLLOW, true);

      // ---- Controls (sticky above the scroll area) ----------------------
      const controls = el('div', { class: 'tl-controls' });

      const select = el('select', { 'aria-label': 'Filter by task' }) as HTMLSelectElement;
      select.append(el('option', { value: 'all' }, 'All tasks'));
      for (const id of state.taskOrder) {
        select.append(el('option', { value: id }, id));
      }
      select.value = state.taskOrder.includes(taskFilter) ? taskFilter : 'all';
      select.addEventListener('change', () => {
        ctx.viewState[K_TASK] = select.value;
        build();
      });
      controls.append(el('label', { class: 'tl-filter' }, 'Task', select));

      const checks = el('div', { class: 'tl-checks' });
      const addCheck = (key: string, def: boolean, text: string): void => {
        const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
        input.checked = vsBool(ctx.viewState, key, def);
        input.addEventListener('change', () => {
          ctx.viewState[key] = input.checked;
          build();
        });
        checks.append(el('label', { class: 'tl-check' }, input, text));
      };
      addCheck(K_LIFE, true, 'Lifecycle');
      addCheck(K_DEC, true, 'Decisions');
      addCheck(K_TOOLS, false, 'Tool calls');
      addCheck(K_TEXT, false, 'Text & usage');
      controls.append(checks);

      const followBtn = el(
        'button',
        {
          class: `btn tl-follow${follow ? ' on' : ''}`,
          type: 'button',
          'aria-pressed': String(follow),
          title: 'Keep scrolled to the newest events',
        },
        'Follow',
      );
      followBtn.addEventListener('click', () => {
        ctx.viewState[K_FOLLOW] = !follow;
        build();
      });
      controls.append(followBtn);

      // ---- Filter the stream --------------------------------------------
      const matched: ArgusEvent[] = [];
      for (const e of history) {
        if (e.type === 'usage' && e.costUsdDelta <= 0) {
          continue;
        }
        const cls = classify(e.type);
        if (cls === 'lifecycle' && !showLife) {
          continue;
        }
        if (cls === 'decisions' && !showDec) {
          continue;
        }
        if (cls === 'tools' && !showTools) {
          continue;
        }
        if (cls === 'text' && !showText) {
          continue;
        }
        if (taskFilter !== 'all' && eventTaskId(e) !== taskFilter) {
          continue;
        }
        matched.push(e);
      }
      const shown = matched.slice(-RENDER_CAP);

      const hint = el(
        'span',
        { class: 'tl-count hint' },
        shown.length === matched.length
          ? `${matched.length} event${matched.length === 1 ? '' : 's'}`
          : `last ${shown.length} of ${matched.length} events`,
      );
      controls.append(hint);

      root.append(controls);

      // ---- The rows ------------------------------------------------------
      const list = el('div', { class: 'tl-list', tabindex: '0' });
      if (shown.length === 0) {
        list.append(
          el(
            'div',
            { class: 'tl-none' },
            'No events match these filters. Turn on more event classes above, or choose a different task.',
          ),
        );
      } else {
        for (const e of shown) {
          list.append(rowEl(e, state));
        }
      }

      list.addEventListener('scroll', () => {
        const dist = list.scrollHeight - list.scrollTop - list.clientHeight;
        ctx.viewState[K_SCROLL] = list.scrollTop;
        if (dist > FOLLOW_SLOP && vsBool(ctx.viewState, K_FOLLOW, true)) {
          ctx.viewState[K_FOLLOW] = false;
          followBtn.classList.remove('on');
          followBtn.setAttribute('aria-pressed', 'false');
        }
      });

      root.append(list);

      // Apply scroll position after layout: follow pins to the bottom;
      // otherwise we restore where the user left off.
      requestAnimationFrame(() => {
        if (!list.isConnected) {
          return;
        }
        if (vsBool(ctx.viewState, K_FOLLOW, true)) {
          list.scrollTop = list.scrollHeight;
        } else {
          list.scrollTop = vsNum(ctx.viewState, K_SCROLL, 0);
        }
      });
    };

    build();
  },
};
