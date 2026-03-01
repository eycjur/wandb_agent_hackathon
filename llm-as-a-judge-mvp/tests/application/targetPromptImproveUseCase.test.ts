import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const mockGetDomainPromptConfig = vi.fn();
const mockGenerateTextForPromptImprovement = vi.fn();
const mockOptimizeTargetPromptWithGEPA = vi.fn();

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

const failedRecords = [
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
      { llmProvider: "ax", axMethod: "gepa" }
    );

    expect(result.resultSource).toBe("gepa");
    expect(result.suggestion).toBe("gepa suggestion");
    expect(mockOptimizeTargetPromptWithGEPA).toHaveBeenCalledTimes(1);
    expect(mockGenerateTextForPromptImprovement).not.toHaveBeenCalled();
  });

  it("ax/gepaが2段とも失敗した場合は通常改善へフォールバックする", async () => {
    mockOptimizeTargetPromptWithGEPA.mockRejectedValue(
      new AppError(504, "PROVIDER_TIMEOUT", "GEPA timeout", "timeout")
    );
    mockGenerateTextForPromptImprovement.mockResolvedValue(
      "【分析サマリー】fallback summary\n【改善案】fallback suggestion"
    );

    const { generateTargetPromptImprovement } = await import(
      "@/lib/application/targetPromptImproveUseCase"
    );

    const result = await generateTargetPromptImprovement(
      failedRecords,
      "resume_summary",
      { llmProvider: "ax", axMethod: "gepa" }
    );

    expect(result.resultSource).toBe("fallback");
    expect(result.analysisSummary).toBe("fallback summary");
    expect(result.suggestion).toBe("fallback suggestion");
    expect(mockOptimizeTargetPromptWithGEPA).toHaveBeenCalledTimes(2);
    expect(result.degradedReason).toContain("stage1:");
    expect(result.degradedReason).toContain("stage2:");
  });

  it("ax/gepaで1段目失敗・2段目成功ならGEPA結果を返す", async () => {
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

    const result = await generateTargetPromptImprovement(
      failedRecords,
      "resume_summary",
      { llmProvider: "ax", axMethod: "gepa" }
    );

    expect(result.resultSource).toBe("gepa");
    expect(result.suggestion).toBe("gepa suggestion stage2");
    expect(mockOptimizeTargetPromptWithGEPA).toHaveBeenCalledTimes(2);
    expect(mockGenerateTextForPromptImprovement).not.toHaveBeenCalled();
  });

  it("ax/gepa成功結果は同一入力ならキャッシュヒットする", async () => {
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
      { llmProvider: "ax", axMethod: "gepa" }
    );
    const second = await generateTargetPromptImprovement(
      failedRecords,
      "resume_summary",
      { llmProvider: "ax", axMethod: "gepa" }
    );

    expect(first.resultSource).toBe("gepa");
    expect(second.resultSource).toBe("gepa");
    expect(second.suggestion).toBe("cached gepa suggestion");
    expect(mockOptimizeTargetPromptWithGEPA).toHaveBeenCalledTimes(1);
  });

  it("non-GEPA実行時はstandard結果を返す", async () => {
    mockGenerateTextForPromptImprovement.mockResolvedValue(
      "【分析サマリー】standard summary\n【改善案】standard suggestion"
    );

    const { generateTargetPromptImprovement } = await import(
      "@/lib/application/targetPromptImproveUseCase"
    );

    const result = await generateTargetPromptImprovement(
      failedRecords,
      "resume_summary",
      { llmProvider: "ax", axMethod: "few-shot" }
    );

    expect(result.resultSource).toBe("standard");
    expect(result.suggestion).toBe("standard suggestion");
  });
});
