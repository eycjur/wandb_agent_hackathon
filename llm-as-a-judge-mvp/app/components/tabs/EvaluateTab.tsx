"use client";

import dynamic from "next/dynamic";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import type { DomainSessionState } from "@/lib/ui/domainSession";
import type { EvaluationResult } from "@/lib/ui/evaluation";

const EvaluationContent = dynamic(
  () => import("./EvaluateTabContent").then((m) => m.EvaluateTabContent),
  { ssr: false }
);

type Props = {
  selectedDomain: DomainId;
  domainSessions: Record<DomainId, DomainSessionState<EvaluationResult>>;
  onPatchDomainSession: (domain: DomainId, patch: Partial<DomainSessionState<EvaluationResult>>) => void;
  onLoadingChange?: (loading: boolean) => void;
  completedStepIndices: number[];
};

export function EvaluateTab(props: Props) {
  return <EvaluationContent {...props} />;
}
