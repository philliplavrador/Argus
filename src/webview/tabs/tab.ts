/**
 * The tab contract. Each tab is one module owning one render root; main.ts
 * re-renders the active tab from scratch on every state change and every
 * 1-second clock tick (Spike D: full re-render at this DOM size is free).
 * Tabs hold NO state of their own beyond what they stash on ctx.viewState.
 */

import type { ArgusEvent, FleetState, WebviewToHost } from '../../core/types';

export type TabId = 'fleet' | 'inbox' | 'timeline' | 'settings';

export interface TabContext {
  /** Send an intent to the extension host. */
  send(msg: WebviewToHost): void;
  /** Current wall-clock ms — use for elapsed/parked durations. */
  now(): number;
  /**
   * Per-tab scratch surviving re-renders (selection index, drafts, expanded
   * rows). Cleared only on full page reload.
   */
  viewState: Record<string, unknown>;
  /** Switch tab programmatically (★ click on a fleet row jumps to inbox). */
  switchTab(id: TabId, focus?: string): void;
  /**
   * Raw event buffer for the Timeline: live batches accumulate here (capped);
   * empty until `requestHistory()` backfills it from the log.
   */
  history(): readonly ArgusEvent[];
  /** Ask the host for the full log once; the answer lands in history(). */
  requestHistory(): void;
}

export interface Tab {
  id: TabId;
  /** Tab-bar label, may carry a live count, e.g. `Inbox ★3`. */
  label(state: FleetState): string;
  render(root: HTMLElement, state: FleetState, ctx: TabContext): void;
  /** Keyboard handling while this tab is active. Return true when consumed. */
  onKey?(e: KeyboardEvent, state: FleetState, ctx: TabContext): boolean;
}
