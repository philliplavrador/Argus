/**
 * Webview entry — a pure view over FleetState.
 *
 * Owns: the vscode message channel, the local fold (same reducer as the
 * host), the tab bar, toasts, and a 1s clock tick. Owns no fleet state of its
 * own: on open it asks for a snapshot; on reopen it does the same. Closing
 * this page affects nothing.
 */

import './theme.css';
import './ui.css';
import './tabs/fleet.css';
import './tabs/inbox.css';
import './tabs/timeline.css';
import './tabs/settings.css';

import { reduce, pendingInbox, isLivePhase } from '../core/reducer';
import type { FleetState, HostToWebview, WebviewToHost } from '../core/types';
import { el } from './dom';
import type { Tab, TabContext, TabId } from './tabs/tab';
import { fleetTab } from './tabs/fleet';
import { inboxTab } from './tabs/inbox';
import { timelineTab } from './tabs/timeline';
import { settingsTab } from './tabs/settings';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): { activeTab?: TabId } | undefined;
  setState(s: { activeTab?: TabId }): void;
};

const vscode = acquireVsCodeApi();
const app = document.getElementById('app') as HTMLElement;

const TABS: Tab[] = [fleetTab, inboxTab, timelineTab, settingsTab];

let state: FleetState | null = null;
let activeTab: TabId = vscode.getState()?.activeTab ?? 'fleet';
let focusHint: string | undefined;

/** Raw event buffer for the Timeline (capped; seeded by 'history'). */
const EVENT_BUFFER_CAP = 2000;
let eventBuffer: import('../core/types').ArgusEvent[] = [];
let historyRequested = false;
const viewStates: Record<TabId, Record<string, unknown>> = {
  fleet: {},
  inbox: {},
  timeline: {},
  settings: {},
};

const ctx: TabContext = {
  send: (msg: WebviewToHost) => vscode.postMessage(msg),
  now: () => Date.now(),
  viewState: viewStates[activeTab],
  switchTab: (id: TabId, focus?: string) => {
    activeTab = id;
    focusHint = focus;
    vscode.setState({ activeTab });
    render();
  },
  history: () => eventBuffer,
  requestHistory: () => {
    if (!historyRequested) {
      historyRequested = true;
      vscode.postMessage({ kind: 'request-history' } satisfies WebviewToHost);
    }
  },
};

window.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as HostToWebview;
  if (msg.kind === 'snapshot') {
    state = msg.state;
    render();
  } else if (msg.kind === 'events') {
    if (state !== null) {
      for (const e of msg.events) {
        state = reduce(state, e);
      }
      bufferEvents(msg.events);
      render();
    }
  } else if (msg.kind === 'history') {
    // Replace the buffer wholesale — the log is the authority on order.
    eventBuffer = msg.events.slice(-EVENT_BUFFER_CAP);
    render();
  } else if (msg.kind === 'toast') {
    showToast(msg.level, msg.text);
  }
});

window.addEventListener('keydown', (e) => {
  if (state === null) {
    return;
  }
  const tab = TABS.find((t) => t.id === activeTab);
  if (tab?.onKey !== undefined && tab.onKey(e, state, ctx)) {
    e.preventDefault();
    e.stopPropagation();
  }
});

/** 1s tick keeps elapsed/parked durations honest while anything is live. */
setInterval(() => {
  if (state !== null && (Object.values(state.tasks).some((t) => isLivePhase(t.phase)) || pendingInbox(state).length > 0)) {
    render();
  }
}, 1000);

function render(): void {
  if (state === null) {
    return;
  }
  ctx.viewState = viewStates[activeTab];
  if (focusHint !== undefined) {
    ctx.viewState['focus'] = focusHint;
    focusHint = undefined;
  }
  const s = state;
  const bar = el(
    'nav',
    { class: 'tabbar', role: 'tablist' },
    ...TABS.map((t) => {
      const isActive = t.id === activeTab;
      const btn = el(
        'button',
        {
          class: `tab${isActive ? ' active' : ''}${t.id === 'inbox' && pendingInbox(s).length > 0 ? ' has-star' : ''}`,
          role: 'tab',
          'aria-selected': String(isActive),
        },
        t.label(s),
      );
      btn.addEventListener('click', () => ctx.switchTab(t.id));
      return btn;
    }),
  );
  const body = el('main', { class: 'tabbody', 'data-tab': activeTab });
  const tab = TABS.find((t) => t.id === activeTab);
  tab?.render(body, s, ctx);

  app.replaceChildren(bar, body);
}

function bufferEvents(events: readonly import('../core/types').ArgusEvent[]): void {
  eventBuffer.push(...events);
  if (eventBuffer.length > EVENT_BUFFER_CAP) {
    eventBuffer = eventBuffer.slice(-EVENT_BUFFER_CAP);
  }
}

function showToast(level: 'info' | 'warn' | 'error', text: string): void {
  const t = el('div', { class: `toast toast-${level}`, role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => {
    t.classList.add('gone');
    setTimeout(() => t.remove(), 300);
  }, 4200);
}

vscode.postMessage({ kind: 'ready' } satisfies WebviewToHost);
