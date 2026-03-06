import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { HumanFeedbackRecord } from "@/lib/infrastructure/humanFeedbackStore";

const mockGetDomainPromptConfig = vi.fn();
const mockGenerateTextForPromptImprovement = vi.fn();
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

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("ax/fewshot実行時はstandard結果を返す", async () => {
    mockOptimizeJudgePromptWithFewShot.mockResolvedValue({
      suggestion: "few-shot suggestion"
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
