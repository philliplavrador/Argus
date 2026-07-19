/**
 * Timeline tab — the event log as per-task swimlanes. PLACEHOLDER: the
 * Phase 4 timeline agent replaces the body per its brief.
 */

import type { FleetState } from '../../core/types';
import { el } from '../dom';
import type { Tab, TabContext } from './tab';

export const timelineTab: Tab = {
  id: 'timeline',
  label: () => 'Timeline',
  render(root: HTMLElement, state: FleetState, ctx: TabContext): void {
    root.append(
      el(
        'div',
        { class: 'empty' },
        el('h2', {}, 'Timeline'),
        el('p', {}, `${state.seq} events recorded. Swimlanes land here.`),
      ),
    );
    void ctx;
  },
};
