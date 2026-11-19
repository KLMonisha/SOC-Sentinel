import type { CounterfactualResponse } from "@/api/types";

/**
 * Session record of the most recent counterfactual run per case, so an exported report can include it ONLY
 * when one genuinely ran in this browser session. In memory; the API stores nothing about counterfactuals.
 */
export interface CounterfactualRecord {
  res: CounterfactualResponse;
  excludedEventId: string;
  reason: string;
  at: string;
}
const runs = new Map<string, CounterfactualRecord>();
export const recordCounterfactual = (caseId: string, r: CounterfactualRecord): void => void runs.set(caseId, r);
export const lastCounterfactual = (caseId: string): CounterfactualRecord | null => runs.get(caseId) ?? null;
export const resetCounterfactualSessions = (): void => runs.clear();
