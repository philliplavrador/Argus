/**
 * Pure text rendering for tree rows and the status bar.
 * No `vscode` imports — unit-testable under node:test.
 */

import { ParsedStatus } from "./status";

/** Unicode progress bar, e.g. pct 47 → `▕████░░░░▏`. */
export function progressBar(pct: number, width = 8): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return "▕" + "█".repeat(filled) + "░".repeat(width - filled) + "▏";
}

/**
 * Task-row description:
 *   running  → `BUILD ▕████░░░░▏47% · opus-4-8` (bar omitted without pct, model omitted if absent)
 *   BLOCKED  → `⏸ BLOCKED · question`
 *   PUSHED   → `✓ PUSHED`
 *   FAILED   → `✗ FAILED`
 *   bad JSON → `⚠ unparsable`
 * A ` ⚠ DETECTOR` suffix is appended per tier ≥ 3 watchdog finding.
 */
export function taskDescription(s: ParsedStatus, warnings: string[] = []): string {
  let base: string;
  if (!s.ok) {
    base = "⚠ unparsable";
  } else if (s.phase === "PUSHED") {
    base = "✓ PUSHED";
  } else if (s.phase === "FAILED") {
    base = "✗ FAILED";
  } else if (s.phase === "BLOCKED") {
    base = "⏸ BLOCKED" + (s.blockedOn?.kind ? ` · ${s.blockedOn.kind}` : "");
  } else {
    base = s.phase;
    if (s.pct !== null) {
      base += ` ${progressBar(s.pct)}${s.pct}%`;
    }
    if (s.model) {
      base += ` · ${s.model}`;
    }
  }
  for (const w of warnings) {
    base += ` ⚠ ${w}`;
  }
  return base;
}

/** Question-row description: `blocking · 12m` or `12m`. */
export function questionDescription(blocking: boolean, ageMin: number | null): string {
  const age = ageMin === null ? "?" : `${Math.max(0, Math.floor(ageMin))}m`;
  return blocking ? `blocking · ${age}` : age;
}

/** Whole minutes elapsed since `iso`; null when missing/invalid. Never negative. */
export function ageMinutes(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) {
    return null;
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return null;
  }
  return Math.max(0, Math.floor((now.getTime() - t) / 60000));
}

/** Compact age for tooltips: `47m`, `3h 12m`, `2d 5h`. */
export function formatAge(min: number | null): string {
  if (min === null) {
    return "unknown";
  }
  if (min < 60) {
    return `${min}m`;
  }
  const h = Math.floor(min / 60);
  if (h < 24) {
    return `${h}h ${min % 60}m`;
  }
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Status bar text: `$(eye) N▶ M❓`. */
export function statusBarText(activeTasks: number, unansweredQuestions: number): string {
  return `$(eye) ${activeTasks}▶ ${unansweredQuestions}❓`;
}
