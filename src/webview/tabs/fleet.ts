/**
 * Fleet tab — one card per task. PLACEHOLDER: the Phase 4 fleet agent
 * replaces the body of `render` (and may add helpers) per its brief; the
 * exported shape is frozen.
 */

import type { FleetState } from '../../core/types';
import { el } from '../dom';
import type { Tab, TabContext } from './tab';

export const fleetTab: Tab = {
  id: 'fleet',
  label: () => 'Fleet',
  render(root: HTMLElement, state: FleetState, ctx: TabContext): void {
    if (state.taskOrder.length === 0) {
      root.append(
        el(
          'div',
          { class: 'empty' },
          el('h2', {}, 'No tasks yet'),
          el(
            'p',
            {},
            'A task is a scoped prompt run by its own agent in its own git worktree. Create one and watch it work here.',
          ),
          el('button', { class: 'btn primary' }, 'New task'),
        ),
      );
      return;
    }
    for (const id of state.taskOrder) {
      const t = state.tasks[id];
      root.append(el('div', { class: 'card' }, `${t.spec.title} — ${t.phase}`));
    }
    void ctx;
  },
};
