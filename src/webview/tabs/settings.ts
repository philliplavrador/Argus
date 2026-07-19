/**
 * Settings tab — writes .argus/config.json via set-config. PLACEHOLDER: the
 * Phase 4 settings agent replaces the body per its brief.
 */

import type { FleetState } from '../../core/types';
import { el } from '../dom';
import type { Tab, TabContext } from './tab';

export const settingsTab: Tab = {
  id: 'settings',
  label: () => 'Settings',
  render(root: HTMLElement, state: FleetState, ctx: TabContext): void {
    root.append(
      el(
        'div',
        { class: 'empty' },
        el('h2', {}, 'Settings'),
        el('p', {}, `Concurrency ${state.config.maxConcurrentAgents} · model ${state.config.defaultModel}. Full form lands here.`),
      ),
    );
    void ctx;
  },
};
