import type { DomainId } from "@/lib/config/domainPromptLoader";
import type { AxMethodId, LLMProviderId } from "@/lib/contracts/generateEvaluate";

export type LLMProviderOptions = {
  llmProvider?: LLMProviderId;
  axMethod?: AxMethodId;
};

export type JudgeResult = {
  score: number;
  reason: string;
  rubricVersion: number;
  passThreshold: number;
  domain: DomainId;
};

export type GenerateEvaluateResult = {
  domain: DomainId;
  rubricVersion: number;
  passThreshold: number;
  pass: boolean;
  generatedOutput: string;
  score: number;
  reason: string;
};

export interface LLMProvider {
  name: string;
  models: {
    target: string;
    judge: string;
  };
  generateOutput(userInput: string, domain: DomainId): Promise<string>;
  judgeOutput(
    userInput: string,
    generatedOutput: string,
    domain: DomainId
  ): Promise<JudgeResult>;
}
