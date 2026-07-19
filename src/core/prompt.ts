/**
 * System-prompt assembly — the *suggestion* half of every dual control.
 *
 * Everything appended here is advice to the agent; the matching enforcement
 * lives in ScopeGuard verdicts and the runner's permission policy (design
 * principle 7). The Settings tab shows this string verbatim so settings are
 * never magic.
 */

import type { ArgusConfig, TaskSpec } from './types';

const VERBOSITY_DIRECTIVE: Record<ArgusConfig['verbosity'], string> = {
  terse:
    'Report progress in single terse lines; no narration, no summaries unless asked.',
  normal:
    'Report progress briefly at meaningful milestones; keep explanations short.',
  detailed:
    'Narrate your plan before acting, explain notable decisions as you go, and summarize each completed step.',
};

const PUSHBACK_DIRECTIVE: Record<ArgusConfig['pushback'], string> = {
  autonomous:
    'Decide autonomously. Ask the operator (AskUserQuestion) only when a choice is irreversible or contradicts the task description.',
  balanced:
    'Ask the operator (AskUserQuestion) when a decision materially shapes the outcome — API contracts, UX behavior, data migrations. Otherwise decide and note it.',
  consult:
    'Consult the operator (AskUserQuestion) before each significant design decision and before any destructive operation. Prefer asking over assuming.',
};

/**
 * The string passed as `systemPrompt.append` for a task's session.
 * Deterministic: same spec + config → same string.
 */
export function buildSystemPromptAppend(spec: TaskSpec, config: ArgusConfig): string {
  const scopeLines =
    spec.scope.include.length > 0
      ? spec.scope.include.map((g) => `  - ${g}`).join('\n')
      : '  (none declared — every write will need operator approval)';

  return [
    `You are an Argus fleet agent. Task: ${spec.id} — ${spec.title}.`,
    '',
    'Working rules:',
    '- Your working directory is a dedicated git worktree for this task. Stay on its branch: never run git checkout/switch, never push, never touch other worktrees.',
    '- Commit your work to the current branch in small, conventional-commit-style commits.',
    '- Your declared write scope (paths relative to the worktree root):',
    scopeLines,
    '- Writes outside that scope are intercepted and sent to the operator for a decision. A denial comes back with a reason: adjust your approach instead of retrying the same write.',
    '- When you need a human decision, use the AskUserQuestion tool with concrete, self-contained options. Your questions land in a queue the operator answers from; include enough context to answer without reading your transcript.',
    `- ${VERBOSITY_DIRECTIVE[config.verbosity]}`,
    `- ${PUSHBACK_DIRECTIVE[config.pushback]}`,
  ].join('\n');
}
