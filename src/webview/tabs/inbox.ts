/**
 * Inbox tab — the single decision queue (§6.1). PLACEHOLDER: the Phase 4
 * inbox agent replaces the body per its brief; the exported shape is frozen.
 */

import { pendingInbox } from '../../core/reducer';
import type { FleetState } from '../../core/types';
import { el } from '../dom';
import type { Tab, TabContext } from './tab';

export const inboxTab: Tab = {
  id: 'inbox',
  label: (s: FleetState) => {
    const n = pendingInbox(s).length;
    return n > 0 ? `Inbox ★${n}` : 'Inbox';
  },
  render(root: HTMLElement, state: FleetState, ctx: TabContext): void {
    const pending = pendingInbox(state);
    if (pending.length === 0) {
      root.append(
        el(
          'div',
          { class: 'empty' },
          el('h2', {}, 'Nothing needs you'),
          el('p', {}, 'When an agent asks a question, strays outside its scope, or fails a gate, the decision lands here — answer it and the agent resumes in place.'),
        ),
      );
      return;
    }
    for (const item of pending) {
      root.append(el('div', { class: 'card' }, `${item.kind} from ${item.taskId}`));
    }
    void ctx;
  },
};
