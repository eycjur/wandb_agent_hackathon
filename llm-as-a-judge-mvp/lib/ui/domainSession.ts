import type { DomainId } from "@/lib/config/domainPromptLoader";

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
