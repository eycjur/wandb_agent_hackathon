"use client";

import dynamic from "next/dynamic";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import type { DomainSessionState } from "@/lib/ui/domainSession";

type EvaluationResult = {
  domain: DomainId;
  rubricVersion: number;
  passThreshold: number;
  pass: boolean;
  userInput: string;
  generatedOutput: string;
  score: number;
  reason: string;
  createdAt: string;
};

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
