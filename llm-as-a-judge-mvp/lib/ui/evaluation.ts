import type { DomainId } from "@/lib/config/domainPromptLoader";
import type { EvaluationSourceType } from "@/lib/contracts/generateEvaluate";

export type EvaluationResult = {
  domain: DomainId;
  rubricVersion: number;
  passThreshold: number;
  pass: boolean;
  userInput: string;
  generatedOutput: string;
  sourceType: EvaluationSourceType;
  score: number;
  reason: string;
  createdAt: string;
};
