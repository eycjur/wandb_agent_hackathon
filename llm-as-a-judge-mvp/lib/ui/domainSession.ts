import type { DomainId } from "@/lib/config/domainPromptLoader";
import type { EvaluationSourceType } from "@/lib/contracts/generateEvaluate";

export type ProgressStage =
  | "idle"
  | "input_accepted"
  | "generating"
  | "generated"
  | "judging"
  | "done"
  | "failed_generating"
  | "failed_judging";

export type DomainSessionState<TResult> = {
  generatedOutput: string;
  generatedForInput: string;
  lastGeneratedInput: string;
  evaluationDraftUserInput: string;
  evaluationDraftOutput: string;
  evaluationDraftSeedUserInput: string;
  evaluationDraftSeedOutput: string;
  hasPendingGeneratedDraft: boolean;
  currentResult: TResult | null;
  previousResult: TResult | null;
  progressStage: ProgressStage;
  requestError: string;
};

export function createDomainSessionState<TResult>(): DomainSessionState<TResult> {
  return {
    generatedOutput: "",
    generatedForInput: "",
    lastGeneratedInput: "",
    evaluationDraftUserInput: "",
    evaluationDraftOutput: "",
    evaluationDraftSeedUserInput: "",
    evaluationDraftSeedOutput: "",
    hasPendingGeneratedDraft: false,
    currentResult: null,
    previousResult: null,
    progressStage: "idle",
    requestError: ""
  };
}

export function createInitialDomainSessions<TResult>(): Record<DomainId, DomainSessionState<TResult>> {
  return {
    resume_summary: createDomainSessionState<TResult>(),
    resume_detail: createDomainSessionState<TResult>(),
    self_pr: createDomainSessionState<TResult>()
  };
}

export function patchDomainSession<TResult>(
  sessions: Record<DomainId, DomainSessionState<TResult>>,
  domain: DomainId,
  patch: Partial<DomainSessionState<TResult>>
): Record<DomainId, DomainSessionState<TResult>> {
  return {
    ...sessions,
    [domain]: {
      ...sessions[domain],
      ...patch
    }
  };
}

export function selectDomainSession<TResult>(
  sessions: Record<DomainId, DomainSessionState<TResult>>,
  domain: DomainId
): DomainSessionState<TResult> {
  return sessions[domain];
}

function normalizeDraftValue(value: string): string {
  return value.trim();
}

export function isEvaluationDraftEmpty<TResult>(
  session: DomainSessionState<TResult>
): boolean {
  return (
    normalizeDraftValue(session.evaluationDraftUserInput).length === 0 &&
    normalizeDraftValue(session.evaluationDraftOutput).length === 0
  );
}

export function isEvaluationDraftSyncedWithSeed<TResult>(
  session: DomainSessionState<TResult>
): boolean {
  return (
    normalizeDraftValue(session.evaluationDraftUserInput) ===
      normalizeDraftValue(session.evaluationDraftSeedUserInput) &&
    normalizeDraftValue(session.evaluationDraftOutput) ===
      normalizeDraftValue(session.evaluationDraftSeedOutput)
  );
}

export function shouldSyncEvaluationDraftWithGenerated<TResult>(
  session: DomainSessionState<TResult>
): boolean {
  return (
    isEvaluationDraftEmpty(session) || isEvaluationDraftSyncedWithSeed(session)
  );
}

export function deriveEvaluationSourceType<TResult>(
  session: DomainSessionState<TResult>
): EvaluationSourceType {
  const hasGeneratedSeed =
    normalizeDraftValue(session.evaluationDraftSeedUserInput).length > 0 ||
    normalizeDraftValue(session.evaluationDraftSeedOutput).length > 0;

  if (!hasGeneratedSeed) {
    return "manual";
  }

  return isEvaluationDraftSyncedWithSeed(session)
    ? "generated"
    : "generated_edited";
}
