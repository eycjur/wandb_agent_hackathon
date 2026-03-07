import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationLogRecord } from "@/lib/infrastructure/evaluationLogStore";

const mockGetDomainPromptConfig = vi.fn();
const mockGenerateTextForPromptImprovement = vi.fn();
const mockOptimizeTargetPromptWithFewShot = vi.fn();

vi.mock("@/lib/config/domainPromptLoader", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/config/domainPromptLoader")>();
  return {
    ...actual,
    getDomainPromptConfig: (...args: unknown[]) => mockGetDomainPromptConfig(...args)
  };
});

vi.mock("@/lib/infrastructure/promptImproveGenerator", () => ({
  generateTextForPromptImprovement: (...args: unknown[]) =>
    mockGenerateTextForPromptImprovement(...args)
}));

vi.mock("@/lib/infrastructure/ax/axFewShotTargetOptimizer", () => ({
  optimizeTargetPromptWithFewShot: (...args: unknown[]) =>
    mockOptimizeTargetPromptWithFewShot(...args)
}));

const failedRecords: EvaluationLogRecord[] = [
  {
    id: "ev_1",
    domain: "resume_summary",
    userInput: "input1",
    generatedOutput: "output1",
    sourceType: "generated",
    judgeResult: {
      score: 1,
      reason: "weak",
      pass: false,
      passThreshold: 4,
      rubricVersion: 1
    },
    createdAt: "2026-03-01T00:00:00.000Z"
  },
  {
    id: "ev_2",
    domain: "resume_summary",
    userInput: "input2",
    generatedOutput: "output2",
    sourceType: "generated",
    judgeResult: {
      score: 2,
      reason: "weak",
      pass: false,
      passThreshold: 4,
      rubricVersion: 1
    },
    createdAt: "2026-03-01T00:00:00.000Z"
  },
  {
    id: "ev_3",
    domain: "resume_summary",
    userInput: "input3",
    generatedOutput: "output3",
    sourceType: "generated",
    judgeResult: {
      score: 2,
      reason: "weak",
      pass: false,
      passThreshold: 4,
      rubricVersion: 1
    },
    createdAt: "2026-03-01T00:00:00.000Z"
  }
];

describe("generateTargetPromptImprovement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDomainPromptConfig.mockResolvedValue({
      domain: "resume_summary",
      targetInstruction: "current target instruction",
      judgeRubric: ["観点A", "観点B"]
    });
  });

  it("ax/fewshot実行時はstandard結果を返す", async () => {
    mockOptimizeTargetPromptWithFewShot.mockResolvedValue({
      suggestion: "few-shot suggestion"
    });

    const { generateTargetPromptImprovement } = await import(
      "@/lib/application/targetPromptImproveUseCase"
    );

    const result = await generateTargetPromptImprovement(
      failedRecords,
      "resume_summary",
      { llmProvider: "ax", improvementMethod: "fewshot" }
    );

    expect(result.resultSource).toBe("standard");
    expect(result.suggestion).toBe("few-shot suggestion");
    expect(mockOptimizeTargetPromptWithFewShot).toHaveBeenCalledTimes(1);
    expect(mockGenerateTextForPromptImprovement).not.toHaveBeenCalled();
  });
});
