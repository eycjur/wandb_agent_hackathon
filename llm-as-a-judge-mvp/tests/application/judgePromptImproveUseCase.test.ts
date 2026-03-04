import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { HumanFeedbackRecord } from "@/lib/infrastructure/humanFeedbackStore";

const mockGetDomainPromptConfig = vi.fn();
const mockGenerateTextForPromptImprovement = vi.fn();
const mockOptimizeJudgePromptWithGEPA = vi.fn();
const mockOptimizeJudgePromptWithFewShot = vi.fn();
const mockGetWeaveProjectId = vi.fn();

vi.mock("@/lib/config/domainPromptLoader", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/config/domainPromptLoader")>();
  return {
    ...actual,
    getDomainPromptConfig: (...args: unknown[]) =>
      mockGetDomainPromptConfig(...args)
  };
});

vi.mock("@/lib/infrastructure/promptImproveGenerator", () => ({
  generateTextForPromptImprovement: (...args: unknown[]) =>
    mockGenerateTextForPromptImprovement(...args)
}));

vi.mock("@/lib/infrastructure/ax/axGepaOptimizer", () => ({
  optimizeJudgePromptWithGEPA: (...args: unknown[]) =>
    mockOptimizeJudgePromptWithGEPA(...args)
}));

vi.mock("@/lib/infrastructure/ax/axFewShotJudgeOptimizer", () => ({
  optimizeJudgePromptWithFewShot: (...args: unknown[]) =>
    mockOptimizeJudgePromptWithFewShot(...args)
}));

vi.mock("@/lib/infrastructure/weave/weaveProjectId", () => ({
  getWeaveProjectId: (...args: unknown[]) => mockGetWeaveProjectId(...args)
}));

const feedbackRecords: HumanFeedbackRecord[] = [
  {
    id: "hf_1",
    domain: "resume_summary",
    userInput: "input1",
    generatedOutput: "output1",
    judgeResult: { score: 2, reason: "short", pass: false },
    humanScore: 4,
    createdAt: "2026-03-01T00:00:00.000Z"
  },
  {
    id: "hf_2",
    domain: "resume_summary",
    userInput: "input2",
    generatedOutput: "output2",
    judgeResult: { score: 2, reason: "short", pass: false },
    humanScore: 5,
    createdAt: "2026-03-01T00:00:00.000Z"
  },
  {
    id: "hf_3",
    domain: "resume_summary",
    userInput: "input3",
    generatedOutput: "output3",
    judgeResult: { score: 3, reason: "ok", pass: false },
    humanScore: 1,
    createdAt: "2026-03-01T00:00:00.000Z"
  }
];

describe("generateJudgePromptImprovement", () => {
  const originalWandbApiKey = process.env.WANDB_API_KEY;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { clearGepaResultCacheForTest } = await import(
      "@/lib/application/promptOptimization/gepaResultCache"
    );
    clearGepaResultCacheForTest();

    mockGetDomainPromptConfig.mockResolvedValue({
      domain: "resume_summary",
      judgeInstruction: "current judge instruction",
      judgeRubric: ["観点A", "観点B"],
      passThreshold: 4
    });
    mockGetWeaveProjectId.mockResolvedValue("entity/project");
  });

  afterEach(() => {
    if (originalWandbApiKey === undefined) {
      delete process.env.WANDB_API_KEY;
    } else {
      process.env.WANDB_API_KEY = originalWandbApiKey;
    }
  });

  it("ax/gepa成功時はGEPA結果を返す", async () => {
    mockOptimizeJudgePromptWithGEPA.mockResolvedValue({
      suggestion: "gepa suggestion",
      analysisSummary: "gepa summary"
    });

    const { generateJudgePromptImprovement } = await import(
      "@/lib/application/judgePromptImproveUseCase"
    );

    const result = await generateJudgePromptImprovement(
      feedbackRecords,
      "resume_summary",
      { llmProvider: "ax", improvementMethod: "gepa" }
    );

    expect(result.resultSource).toBe("gepa");
    expect(result.suggestion).toBe("gepa suggestion");
    expect(mockOptimizeJudgePromptWithGEPA).toHaveBeenCalledTimes(1);
    expect(mockGenerateTextForPromptImprovement).not.toHaveBeenCalled();
  });

  it("ax/gepa失敗時は再試行せずエラーを投げる", async () => {
    mockOptimizeJudgePromptWithGEPA.mockRejectedValue(
      new AppError(504, "PROVIDER_TIMEOUT", "GEPA timeout", "timeout")
    );

    const { generateJudgePromptImprovement } = await import(
      "@/lib/application/judgePromptImproveUseCase"
    );

    const error = await generateJudgePromptImprovement(
      feedbackRecords,
      "resume_summary",
      { llmProvider: "ax", improvementMethod: "gepa" }
    ).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("PROVIDER_TIMEOUT");
    expect(mockOptimizeJudgePromptWithGEPA).toHaveBeenCalledTimes(1);
    expect(mockGenerateTextForPromptImprovement).not.toHaveBeenCalled();
  });

  it("ax/gepaは再試行しないため、2回目の成功モックがあっても1回目失敗で終了する", async () => {
    mockOptimizeJudgePromptWithGEPA
      .mockRejectedValueOnce(
        new AppError(504, "PROVIDER_TIMEOUT", "GEPA timeout", "timeout")
      )
      .mockResolvedValueOnce({
        suggestion: "gepa suggestion stage2",
        analysisSummary: "gepa summary stage2"
      });

    const { generateJudgePromptImprovement } = await import(
      "@/lib/application/judgePromptImproveUseCase"
    );

    const error = await generateJudgePromptImprovement(
      feedbackRecords,
      "resume_summary",
      { llmProvider: "ax", improvementMethod: "gepa" }
    ).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("PROVIDER_TIMEOUT");
    expect(mockOptimizeJudgePromptWithGEPA).toHaveBeenCalledTimes(1);
    expect(mockGenerateTextForPromptImprovement).not.toHaveBeenCalled();
  });

  it("ax/gepa成功結果は同一入力でも毎回最適化を実行する", async () => {
    mockOptimizeJudgePromptWithGEPA.mockResolvedValue({
      suggestion: "cached gepa suggestion",
      analysisSummary: "cached gepa summary"
    });

    const { generateJudgePromptImprovement } = await import(
      "@/lib/application/judgePromptImproveUseCase"
    );

    const first = await generateJudgePromptImprovement(
      feedbackRecords,
      "resume_summary",
      { llmProvider: "ax", improvementMethod: "gepa" }
    );
    const second = await generateJudgePromptImprovement(
      feedbackRecords,
      "resume_summary",
      { llmProvider: "ax", improvementMethod: "gepa" }
    );

    expect(first.resultSource).toBe("gepa");
    expect(second.resultSource).toBe("gepa");
    expect(second.suggestion).toBe("cached gepa suggestion");
    expect(mockOptimizeJudgePromptWithGEPA).toHaveBeenCalledTimes(2);
  });

  it("non-GEPA実行時はstandard結果を返す", async () => {
    mockOptimizeJudgePromptWithFewShot.mockResolvedValue({
      suggestion: "few-shot suggestion",
      analysisSummary: "few-shot summary"
    });

    const { generateJudgePromptImprovement } = await import(
      "@/lib/application/judgePromptImproveUseCase"
    );

    const result = await generateJudgePromptImprovement(
      feedbackRecords,
      "resume_summary",
      { llmProvider: "ax", improvementMethod: "fewshot" }
    );

    expect(result.resultSource).toBe("standard");
    expect(result.suggestion).toBe("few-shot suggestion");
    expect(mockOptimizeJudgePromptWithFewShot).toHaveBeenCalledTimes(1);
    expect(mockGenerateTextForPromptImprovement).not.toHaveBeenCalled();
  });

  it("gemini プロバイダで WANDB_API_KEY が未設定の場合 CONFIG_ERROR(500) を投げる", async () => {
    delete process.env.WANDB_API_KEY;

    const { generateJudgePromptImprovement } = await import(
      "@/lib/application/judgePromptImproveUseCase"
    );

    const error = await generateJudgePromptImprovement(
      feedbackRecords,
      "resume_summary",
      { llmProvider: "gemini" }
    ).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(500);
    expect(error.code).toBe("CONFIG_ERROR");
  });
});
