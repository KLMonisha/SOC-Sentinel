/** Central runtime config. Mocks are opt-in and never a silent fallback. */

/** A positive whole number of milliseconds within [min, max]; anything else falls back (never throws). */
export function parseTimeoutMs(raw: unknown, fallback: number, min = 1_000, max = 600_000): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return n >= min && n <= max ? n : fallback;
}

export const DEFAULT_RED_TEAM_TIMEOUT_MS = 90_000;

export const config = {
  useMocks: import.meta.env.VITE_USE_MOCKS === "true",
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "",
  /** Client-side limit for one adversarial run. Set VITE_REDTEAM_TIMEOUT_MS (1000–600000) to change it. */
  redTeamTimeoutMs: parseTimeoutMs(import.meta.env.VITE_REDTEAM_TIMEOUT_MS, DEFAULT_RED_TEAM_TIMEOUT_MS),
} as const;
