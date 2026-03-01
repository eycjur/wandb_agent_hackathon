import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { generateJudgePromptImprovement } from "@/lib/application/judgePromptImproveUseCase";
import type { HumanFeedbackRecord } from "@/lib/infrastructure/humanFeedbackStore";
import { AppError } from "@/lib/errors";

vi.mock("@/lib/config/domainPromptLoader", () => ({
  getDomainPromptConfig: vi.fn().mockResolvedValue({
    domain: "resume_summary",
    rubricVersion: 1,
    passThreshold: 4,
    targetInstruction: "target",
    judgeInstruction: "judge instruction",
    judgeRubric: ["rubric1"],
    samples: [],
  }),
}));

vi.mock("@/lib/infrastructure/promptImproveGenerator", () => ({
  generateTextForPromptImprovement: vi.fn(),
}));

vi.mock("@/lib/infrastructure/weave/weaveProjectId", () => ({
  getWeaveProjectId: vi.fn().mockResolvedValue("entity/project"),
}));

vi.mock("@/lib/infrastructure/ax/axGepaOptimizer", () => ({
  optimizeJudgePromptWithGEPA: vi.fn(),
}));

const feedbackRecordsWithJudge: HumanFeedbackRecord[] = [
  {
    id: "hf_1",
    domain: "resume_summary",
    userInput: "user input",
    generatedOutput: "generated output",
    judgeResult: { score: 5, reason: "good", pass: true },
    humanScore: 3,
    createdAt: new Date().toISOString(),
  },
];

describe("generateJudgePromptImprovement", () => {
  const originalWandbApiKey = process.env.WANDB_API_KEY;

  afterEach(() => {
    if (originalWandbApiKey === undefined) {
      delete process.env.WANDB_API_KEY;
    } else {
      process.env.WANDB_API_KEY = originalWandbApiKey;
    }
  });

  it("gemini プロバイダで WANDB_API_KEY が未設定の場合 CONFIG_ERROR(500) を投げる", async () => {
    delete process.env.WANDB_API_KEY;

    const error = await generateJudgePromptImprovement(
      feedbackRecordsWithJudge,
      "resume_summary",
      { llmProvider: "gemini" },
    ).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(500);
    expect(error.code).toBe("CONFIG_ERROR");
  });
});
