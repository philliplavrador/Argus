/**
 * Inbox tab — the single decision queue (§6.1). One keyboard-first queue for
 * every agent's question: pending items are cards, oldest first, each carrying
 * the parked clock that is the whole argument for the feature.
 *
 * State lives on ctx.viewState, never in the DOM — main.ts rebuilds this tab
 * from scratch on every state change and every 1s tick. Drafts (free text,
 * globs, notes), the selected item, chosen options and open reveals are all
 * stashed there so they survive the churn; focus and caret are recaptured
 * across each rebuild.
 */

import { pendingInbox } from '../../core/reducer';
import { suggestGlobForPath } from '../../core/scope';
import type {
  FleetState,
  InboxItem,
  InboxResolution,
  MergeConflictItem,
  QuestionItem,
  ScopeEscalationItem,
  VerifyFailureItem,
} from '../../core/types';
import { el, fmtDuration } from '../dom';
import type { Tab, TabContext } from './tab';

/** The 2-minute mark past which the parked clock turns to the warn colour. */
const OVERDUE_MS = 120_000;

/** The render root main.ts handed us last, so keyboard/click handlers can
 * rebuild in place without reaching into main.ts. */
let rootEl: HTMLElement | null = null;

export const inboxTab: Tab = {
  id: 'inbox',
  label: (s: FleetState) => {
    const n = pendingInbox(s).length;
    return n > 0 ? `Inbox ★${n}` : 'Inbox';
  },
  render(root: HTMLElement, state: FleetState, ctx: TabContext): void {
    rootEl = root;
    renderInto(root, state, ctx);
  },
  onKey(e: KeyboardEvent, state: FleetState, ctx: TabContext): boolean {
    const pending = pendingInbox(state);
    if (pending.length === 0) {
      return false;
    }
    const target = e.target as HTMLElement | null;
    const inField =
      target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    const selId = resolveSel(pending, ctx);

    if (e.key === 'Escape') {
      if (selId !== null && ctx.viewState[`reveal:${selId}`] !== undefined) {
        delete ctx.viewState[`reveal:${selId}`];
        rerender(state, ctx);
        return true;
      }
      if (inField && target !== null) {
        target.blur();
        return true;
      }
      return false;
    }

    // While typing, the field owns every other key.
    if (inField) {
      return false;
    }

    const idx = pending.findIndex((p) => p.id === selId);
    const item = idx >= 0 ? pending[idx] : pending[0];

    if (e.key === 'j' || e.key === 'ArrowDown') {
      const ni = Math.min(pending.length - 1, idx < 0 ? 0 : idx + 1);
      ctx.viewState['sel'] = pending[ni].id;
      rerender(state, ctx);
      return true;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      const ni = Math.max(0, idx < 0 ? 0 : idx - 1);
      ctx.viewState['sel'] = pending[ni].id;
      rerender(state, ctx);
      return true;
    }
    if (/^[1-9]$/.test(e.key)) {
      if (item.kind === 'question') {
        const n = Number.parseInt(e.key, 10) - 1;
        if (n < item.options.length) {
          toggleOption(ctx, item, n);
          rerender(state, ctx);
          return true;
        }
      }
      return false;
    }
    if (e.key === 'Enter') {
      if (item.kind === 'question') {
        return submitQuestion(ctx, state, item);
      }
      return false;
    }
    return false;
  },
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function rerender(state: FleetState, ctx: TabContext): void {
  if (rootEl !== null) {
    renderInto(rootEl, state, ctx);
  }
}

/** Rebuild `root` in place, preserving whatever input/caret was focused. */
function renderInto(root: HTMLElement, state: FleetState, ctx: TabContext): void {
  const focus = captureFocus();
  root.replaceChildren();
  buildContent(root, state, ctx);
  if (focus !== null) {
    restoreFocus(root, focus);
  }
}

function buildContent(root: HTMLElement, state: FleetState, ctx: TabContext): void {
  const pending = pendingInbox(state);
  if (pending.length === 0) {
    root.append(
      el(
        'div',
        { class: 'empty' },
        el('h2', {}, 'Nothing needs you'),
        el(
          'p',
          {},
          'When an agent asks a question, strays outside its scope, or fails a gate, the decision lands here — answer it and the agent resumes in place.',
        ),
      ),
    );
    return;
  }

  const selId = resolveSel(pending, ctx);

  root.append(el('div', { class: 'inbox-hint' }, 'j/k move · 1–9 choose · Enter answer'));

  const list = el('div', { class: 'inbox-list' });
  for (const item of pending) {
    list.append(renderItem(item, item.id === selId, state, ctx));
  }
  root.append(list);

  const resolved = state.inbox.filter((i) => i.resolvedAt !== null).length;
  if (resolved > 0) {
    root.append(
      el(
        'div',
        { class: 'inbox-answered' },
        `${resolved} ${resolved === 1 ? 'answer' : 'answers'} recorded — see Timeline`,
      ),
    );
  }
}

function renderItem(
  item: InboxItem,
  selected: boolean,
  state: FleetState,
  ctx: TabContext,
): HTMLElement {
  const card = el('div', {
    class: `card inbox-item${selected ? ' selected' : ''}`,
    'data-kind': item.kind,
  });

  card.append(
    el(
      'div',
      { class: 'inbox-head' },
      kindChip(item.kind),
      el('span', { class: 'inbox-title' }, taskTitle(state, item)),
      waitEl(item, ctx),
    ),
  );

  let body: Node[] = [];
  switch (item.kind) {
    case 'question':
      body = questionBody(item, state, ctx);
      break;
    case 'scope-escalation':
      body = scopeBody(item, state, ctx);
      break;
    case 'verify-failure':
      body = verifyBody(item, state, ctx);
      break;
    case 'merge-conflict':
      body = mergeBody(item, state, ctx);
      break;
  }
  card.append(el('div', { class: 'inbox-body' }, ...body));

  card.addEventListener('click', (e) => {
    const tgt = e.target as HTMLElement;
    if (tgt.closest('button, input, textarea, a')) {
      return;
    }
    if (ctx.viewState['sel'] !== item.id) {
      ctx.viewState['sel'] = item.id;
      rerender(state, ctx);
    }
  });

  return card;
}

// ---------------------------------------------------------------------------
// Per-kind bodies
// ---------------------------------------------------------------------------

function questionBody(item: QuestionItem, state: FleetState, ctx: TabContext): Node[] {
  const nodes: Node[] = [];
  if (item.header !== null && item.header.length > 0) {
    nodes.push(el('div', { class: 'inbox-qheader' }, item.header));
  }
  nodes.push(el('p', { class: 'inbox-question' }, item.question));

  const chosen = optsOf(ctx, item.id);
  const opts = el('div', { class: 'inbox-opts', role: 'group' });
  item.options.forEach((o, i) => {
    const isChosen = chosen.includes(o.label);
    const row = el('button', {
      class: `inbox-opt${isChosen ? ' chosen' : ''}`,
      type: 'button',
      'aria-pressed': String(isChosen),
    });
    row.append(
      el('span', { class: `inbox-key${i < 9 ? '' : ' ghost'}` }, i < 9 ? String(i + 1) : '·'),
    );
    const txt = el(
      'span',
      { class: 'inbox-opt-text' },
      el('span', { class: 'inbox-opt-label' }, o.label),
    );
    if (o.description !== null && o.description.length > 0) {
      txt.append(el('span', { class: 'inbox-opt-desc' }, ` — ${o.description}`));
    }
    row.append(txt);
    row.addEventListener('click', () => {
      toggleOption(ctx, item, i);
      rerender(state, ctx);
    });
    opts.append(row);
  });
  nodes.push(opts);

  const dk = `draft:${item.id}:free`;
  const free = el('input', {
    type: 'text',
    class: 'inbox-free',
    placeholder: 'Or type your own answer…',
    'data-fkey': `${item.id}:free`,
  }) as HTMLInputElement;
  free.value = draftOf(ctx, dk, '');
  free.addEventListener('input', () => {
    ctx.viewState[dk] = free.value;
  });
  free.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submitQuestion(ctx, state, item);
    }
  });
  nodes.push(free);

  const submit = el('button', { class: 'btn primary inbox-answer', type: 'button' }, 'Answer');
  submit.addEventListener('click', () => {
    if (!submitQuestion(ctx, state, item)) {
      free.focus();
    }
  });
  nodes.push(submit);
  return nodes;
}

function scopeBody(item: ScopeEscalationItem, state: FleetState, ctx: TabContext): Node[] {
  const nodes: Node[] = [];
  nodes.push(
    el(
      'p',
      { class: 'inbox-line' },
      `${item.taskId} wants to ${item.tool === 'Bash' ? 'run' : 'edit'} `,
      el('code', { class: 'mono' }, item.path),
    ),
  );
  if (item.overlappingTasks.length > 0) {
    nodes.push(
      el(
        'p',
        { class: 'inbox-danger' },
        `⚠ overlaps the declared scope of ${item.overlappingTasks.join(', ')}`,
      ),
    );
  }

  const allow = actionBtn('Allow once', () =>
    answer(ctx, state, item, { rkind: 'scope-escalation', action: 'allow-once' }),
  );
  const deny = actionBtn('Deny', () => {
    toggleReveal(ctx, item.id, 'deny');
    rerender(state, ctx);
  });
  // A Bash escalation carries a command, not a path — there is no glob to
  // expand, so the expand action would be meaningless (review C7).
  if (item.tool === 'Bash') {
    nodes.push(el('div', { class: 'inbox-actions' }, allow, deny));
  } else {
    const expand = actionBtn('Allow & expand scope', () => {
      toggleReveal(ctx, item.id, 'expand');
      rerender(state, ctx);
    });
    nodes.push(el('div', { class: 'inbox-actions' }, allow, expand, deny));
  }

  const reveal = ctx.viewState[`reveal:${item.id}`];
  if (reveal === 'expand') {
    const dk = `draft:${item.id}:glob`;
    const preset = suggestGlobForPath(item.path);
    const inp = el('input', {
      type: 'text',
      placeholder: 'Scope glob, e.g. src/lib/**',
      'data-fkey': `${item.id}:glob`,
    }) as HTMLInputElement;
    inp.value = draftOf(ctx, dk, preset);
    inp.addEventListener('input', () => {
      ctx.viewState[dk] = inp.value;
    });
    const confirm = el('button', { class: 'btn primary', type: 'button' }, 'Expand & allow');
    confirm.addEventListener('click', () => {
      const glob = draftOf(ctx, dk, preset).trim();
      if (glob === '') {
        inp.focus();
        return;
      }
      answer(ctx, state, item, { rkind: 'scope-escalation', action: 'expand-scope', glob });
    });
    nodes.push(
      el(
        'div',
        { class: 'inbox-reveal' },
        el('label', {}, 'New scope glob'),
        inp,
        el('p', { class: 'hint' }, 'The task keeps this glob for the rest of its run.'),
        confirm,
      ),
    );
  } else if (reveal === 'deny') {
    const dk = `draft:${item.id}:deny`;
    const inp = el('input', {
      type: 'text',
      placeholder: 'Why is this write out of bounds?',
      'data-fkey': `${item.id}:deny`,
    }) as HTMLInputElement;
    inp.value = draftOf(ctx, dk, '');
    inp.addEventListener('input', () => {
      ctx.viewState[dk] = inp.value;
    });
    const confirm = el('button', { class: 'btn danger', type: 'button' }, 'Deny the write');
    confirm.addEventListener('click', () => {
      const reason = draftOf(ctx, dk, '').trim();
      if (reason === '') {
        inp.focus();
        return;
      }
      answer(ctx, state, item, { rkind: 'scope-escalation', action: 'deny', reason });
    });
    nodes.push(
      el(
        'div',
        { class: 'inbox-reveal' },
        el('label', {}, 'Reason'),
        inp,
        el('p', { class: 'hint' }, 'The agent sees this and takes another approach.'),
        confirm,
      ),
    );
  }
  return nodes;
}

function verifyBody(item: VerifyFailureItem, state: FleetState, ctx: TabContext): Node[] {
  const g = item.gate;
  const nodes: Node[] = [];
  nodes.push(
    el(
      'p',
      { class: 'inbox-line' },
      `Gate ‘${g.name}’ failed (exit ${g.exitCode}) after ${fmtDuration(g.durationMs)}`,
    ),
  );
  nodes.push(el('div', { class: 'inbox-cmd' }, el('code', { class: 'mono' }, g.command)));
  nodes.push(el('pre', { class: 'inbox-pre mono' }, g.outputTail.length > 0 ? g.outputTail : '(no output)'));

  const back = actionBtn('Send back to agent', () => {
    toggleReveal(ctx, item.id, 'send-back');
    rerender(state, ctx);
  });
  const override = actionBtn('Override', () =>
    answer(ctx, state, item, { rkind: 'verify-failure', action: 'override' }),
  );
  override.setAttribute('title', 'Pass the gate anyway');
  const abandon = el('button', { class: 'btn danger', type: 'button' }, 'Abandon task');
  abandon.addEventListener('click', () =>
    answer(ctx, state, item, { rkind: 'verify-failure', action: 'abandon' }),
  );
  nodes.push(el('div', { class: 'inbox-actions' }, back, override, abandon));
  nodes.push(
    el('p', { class: 'hint' }, 'Override passes the gate anyway and sends the task on to merge.'),
  );

  if (ctx.viewState[`reveal:${item.id}`] === 'send-back') {
    const dk = `draft:${item.id}:note`;
    const ta = el('textarea', {
      placeholder: 'Optional note — what to fix or try next…',
      'data-fkey': `${item.id}:note`,
    }) as HTMLTextAreaElement;
    ta.value = draftOf(ctx, dk, '');
    ta.addEventListener('input', () => {
      ctx.viewState[dk] = ta.value;
    });
    const confirm = el('button', { class: 'btn primary', type: 'button' }, 'Send back');
    confirm.addEventListener('click', () => {
      const note = draftOf(ctx, dk, '').trim();
      answer(ctx, state, item, {
        rkind: 'verify-failure',
        action: 'send-back',
        note: note === '' ? null : note,
      });
    });
    nodes.push(
      el('div', { class: 'inbox-reveal' }, el('label', {}, 'Note to the agent'), ta, confirm),
    );
  }
  return nodes;
}

function mergeBody(item: MergeConflictItem, state: FleetState, ctx: TabContext): Node[] {
  const nodes: Node[] = [];
  const n = item.files.length;
  nodes.push(el('p', { class: 'inbox-line' }, `Rebase hit conflicts in ${n} ${n === 1 ? 'file' : 'files'}`));

  const files = el('ul', { class: 'inbox-files' });
  for (const f of item.files) {
    files.append(el('li', {}, el('code', { class: 'mono' }, f)));
  }
  nodes.push(files);
  nodes.push(el('pre', { class: 'inbox-pre mono' }, item.detail.length > 0 ? item.detail : '(no detail)'));

  const fix = actionBtn('Let the agent fix it', () =>
    answer(ctx, state, item, { rkind: 'merge-conflict', action: 'agent-fix' }),
  );
  const open = actionBtn('Open in editor', () =>
    answer(ctx, state, item, { rkind: 'merge-conflict', action: 'open-editor' }),
  );
  const abandon = el('button', { class: 'btn danger', type: 'button' }, 'Abandon task');
  abandon.addEventListener('click', () =>
    answer(ctx, state, item, { rkind: 'merge-conflict', action: 'abandon' }),
  );
  nodes.push(el('div', { class: 'inbox-actions' }, fix, open, abandon));
  nodes.push(
    el(
      'p',
      { class: 'hint' },
      'Open in editor returns the task to Ready; merge again once you’ve resolved the conflict.',
    ),
  );
  return nodes;
}

// ---------------------------------------------------------------------------
// Submit & selection
// ---------------------------------------------------------------------------

function submitQuestion(ctx: TabContext, state: FleetState, item: QuestionItem): boolean {
  const opts = optsOf(ctx, item.id);
  const text = draftOf(ctx, `draft:${item.id}:free`, '').trim();
  if (opts.length === 0 && text === '') {
    return false;
  }
  answer(ctx, state, item, {
    rkind: 'question',
    optionLabels: opts,
    freeText: text === '' ? null : text,
  });
  return true;
}

/** Send the resolution, clear this item's drafts, and move selection on. */
function answer(
  ctx: TabContext,
  state: FleetState,
  item: InboxItem,
  resolution: InboxResolution,
): void {
  // A second click before the inbox-resolved event round-trips would throw
  // "not pending" server-side (review C13) — latch the send per item.
  if (ctx.viewState[`sent:${item.id}`] === true) {
    return;
  }
  ctx.viewState[`sent:${item.id}`] = true;
  ctx.send({ kind: 'answer', itemId: item.id, resolution });

  const pending = pendingInbox(state);
  const idx = pending.findIndex((p) => p.id === item.id);
  const next = pending[idx + 1] ?? pending[idx - 1] ?? null;

  delete ctx.viewState[`opts:${item.id}`];
  delete ctx.viewState[`reveal:${item.id}`];
  delete ctx.viewState[`draft:${item.id}:free`];
  delete ctx.viewState[`draft:${item.id}:glob`];
  delete ctx.viewState[`draft:${item.id}:deny`];
  delete ctx.viewState[`draft:${item.id}:note`];

  ctx.viewState['sel'] = next !== null ? next.id : item.id;
  rerender(state, ctx);
}

/**
 * The selected item id: a one-shot fleet ★ focus wins first, then a still-valid
 * remembered selection, else the first pending item. Always persisted back.
 */
function resolveSel(pending: InboxItem[], ctx: TabContext): string | null {
  if (pending.length === 0) {
    return null;
  }
  const focus = ctx.viewState['focus'];
  if (typeof focus === 'string') {
    delete ctx.viewState['focus'];
    const hit = pending.find((p) => p.id === focus) ?? pending.find((p) => p.taskId === focus);
    if (hit !== undefined) {
      ctx.viewState['sel'] = hit.id;
      return hit.id;
    }
  }
  const sel = ctx.viewState['sel'];
  if (typeof sel === 'string' && pending.some((p) => p.id === sel)) {
    return sel;
  }
  ctx.viewState['sel'] = pending[0].id;
  return pending[0].id;
}

// ---------------------------------------------------------------------------
// Option selection state
// ---------------------------------------------------------------------------

function optsOf(ctx: TabContext, id: string): string[] {
  const v = ctx.viewState[`opts:${id}`];
  return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as string[]) : [];
}

function toggleOption(ctx: TabContext, item: QuestionItem, n: number): void {
  const label = item.options[n].label;
  let cur = optsOf(ctx, item.id);
  if (item.multiSelect) {
    cur = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
  } else {
    cur = cur.length === 1 && cur[0] === label ? [] : [label];
  }
  ctx.viewState[`opts:${item.id}`] = cur;
}

// ---------------------------------------------------------------------------
// Small builders & helpers
// ---------------------------------------------------------------------------

function actionBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { class: 'btn', type: 'button' }, label);
  b.addEventListener('click', onClick);
  return b;
}

function kindChip(kind: InboxItem['kind']): HTMLElement {
  switch (kind) {
    case 'question':
      return el('span', { class: 'pill' }, 'Question');
    case 'scope-escalation':
      return el('span', { class: 'pill warn' }, 'Scope');
    case 'verify-failure':
      return el('span', { class: 'pill bad' }, 'Verify failed');
    case 'merge-conflict':
      return el('span', { class: 'pill bad' }, 'Merge conflict');
  }
}

function taskTitle(state: FleetState, item: InboxItem): string {
  return state.tasks[item.taskId]?.spec.title ?? item.taskId;
}

/** The parked clock — the feature's whole argument. Warn colour past 2 min. */
function waitEl(item: InboxItem, ctx: TabContext): HTMLElement {
  const raised = Date.parse(item.raisedAt);
  const waited = Number.isNaN(raised) ? 0 : ctx.now() - raised;
  return el(
    'span',
    { class: `inbox-wait${waited >= OVERDUE_MS ? ' over' : ''}` },
    `waiting ${fmtDuration(waited)}`,
  );
}

function draftOf(ctx: TabContext, key: string, fallback: string): string {
  const v = ctx.viewState[key];
  return typeof v === 'string' ? v : fallback;
}

function toggleReveal(ctx: TabContext, id: string, name: string): void {
  const k = `reveal:${id}`;
  if (ctx.viewState[k] === name) {
    delete ctx.viewState[k];
  } else {
    ctx.viewState[k] = name;
  }
}

// ---------------------------------------------------------------------------
// Focus preservation across full rebuilds
// ---------------------------------------------------------------------------

interface FocusSnapshot {
  key: string;
  start: number;
  end: number;
}

function captureFocus(): FocusSnapshot | null {
  const a = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (a === null || typeof a.getAttribute !== 'function') {
    return null;
  }
  const key = a.getAttribute('data-fkey');
  if (key === null) {
    return null;
  }
  let start = 0;
  let end = 0;
  try {
    start = a.selectionStart ?? 0;
    end = a.selectionEnd ?? 0;
  } catch {
    // Some input types disallow selection reads; caret restore is best-effort.
  }
  return { key, start, end };
}

function restoreFocus(root: HTMLElement, f: FocusSnapshot): void {
  requestAnimationFrame(() => {
    const found = root.querySelector(`[data-fkey="${CSS.escape(f.key)}"]`);
    if (found === null) {
      return;
    }
    const input = found as HTMLInputElement;
    try {
      input.focus();
      input.setSelectionRange(f.start, f.end);
    } catch {
      // best-effort — element may not support selection ranges
    }
  });
}
