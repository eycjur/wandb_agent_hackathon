import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { EvaluationLogRecord } from "@/lib/infrastructure/evaluationLogStore";

const mockGetDomainPromptConfig = vi.fn();
const mockGenerateTextForPromptImprovement = vi.fn();
const mockOptimizeTargetPromptWithGEPA = vi.fn();
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

vi.mock("@/lib/infrastructure/ax/axGepaTargetOptimizer", () => ({
  optimizeTargetPromptWithGEPA: (...args: unknown[]) =>
    mockOptimizeTargetPromptWithGEPA(...args)
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
  beforeEach(async () => {
    vi.clearAllMocks();
    const { clearGepaResultCacheForTest } = await import(
      "@/lib/application/promptOptimization/gepaResultCache"
    );
    clearGepaResultCacheForTest();

    mockGetDomainPromptConfig.mockResolvedValue({
      domain: "resume_summary",
      targetInstruction: "current target instruction",
      judgeRubric: ["観点A", "観点B"]
    });
  });

  it("ax/gepa成功時はGEPA結果を返す", async () => {
    mockOptimizeTargetPromptWithGEPA.mockResolvedValue({
      suggestion: "gepa suggestion",
      analysisSummary: "gepa summary"
    });

    const { generateTargetPromptImprovement } = await import(
      "@/lib/application/targetPromptImproveUseCase"
    );

    const result = await generateTargetPromptImprovement(
      failedRecords,
      "resume_summary",
      { llmProvider: "ax", improvementMethod: "gepa" }
    );

    expect(result.resultSource).toBe("gepa");
    expect(result.suggestion).toBe("gepa suggestion");
    expect(mockOptimizeTargetPromptWithGEPA).toHaveBeenCalledTimes(1);
    expect(mockGenerateTextForPromptImprovement).not.toHaveBeenCalled();
  });

  it("ax/gepa失敗時は再試行せずエラーを投げる", async () => {
    mockOptimizeTargetPromptWithGEPA.mockRejectedValue(
      new AppError(504, "PROVIDER_TIMEOUT", "GEPA timeout", "timeout")
    );

    const { generateTargetPromptImprovement } = await import(
      "@/lib/application/targetPromptImproveUseCase"
    );

    const error = await generateTargetPromptImprovement(
      failedRecords,
      "resume_summary",
      { llmProvider: "ax", improvementMethod: "gepa" }
    ).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("PROVIDER_TIMEOUT");
    expect(mockOptimizeTargetPromptWithGEPA).toHaveBeenCalledTimes(1);
    expect(mockGenerateTextForPromptImprovement).not.toHaveBeenCalled();
  });

  it("ax/gepaは再試行しないため、2回目の成功モックがあっても1回目失敗で終了する", async () => {
    mockOptimizeTargetPromptWithGEPA
      .mockRejectedValueOnce(
        new AppError(504, "PROVIDER_TIMEOUT", "GEPA timeout", "timeout")
      )
      .mockResolvedValueOnce({
        suggestion: "gepa suggestion stage2",
        analysisSummary: "gepa summary stage2"
      });

    const { generateTargetPromptImprovement } = await import(
      "@/lib/application/targetPromptImproveUseCase"
    );

    const error = await generateTargetPromptImprovement(
      failedRecords,
      "resume_summary",
      { llmProvider: "ax", improvementMethod: "gepa" }
    ).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("PROVIDER_TIMEOUT");
    expect(mockOptimizeTargetPromptWithGEPA).toHaveBeenCalledTimes(1);
    expect(mockGenerateTextForPromptImprovement).not.toHaveBeenCalled();
  });

  it("ax/gepa成功結果は同一入力でも毎回最適化を実行する", async () => {
    mockOptimizeTargetPromptWithGEPA.mockResolvedValue({
      suggestion: "cached gepa suggestion",
      analysisSummary: "cached gepa summary"
    });

    const { generateTargetPromptImprovement } = await import(
      "@/lib/application/targetPromptImproveUseCase"
    );

    const first = await generateTargetPromptImprovement(
      failedRecords,
      "resume_summary",
      { llmProvider: "ax", improvementMethod: "gepa" }
    );
    const second = await generateTargetPromptImprovement(
      failedRecords,
      "resume_summary",
      { llmProvider: "ax", improvementMethod: "gepa" }
    );

    expect(first.resultSource).toBe("gepa");
    expect(second.resultSource).toBe("gepa");
    expect(second.suggestion).toBe("cached gepa suggestion");
    expect(mockOptimizeTargetPromptWithGEPA).toHaveBeenCalledTimes(2);
  });

  it("non-GEPA実行時はstandard結果を返す", async () => {
    mockOptimizeTargetPromptWithFewShot.mockResolvedValue({
      suggestion: "few-shot suggestion",
      analysisSummary: "few-shot summary"
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
