import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HumanFeedbackRecord } from "@/lib/infrastructure/humanFeedbackStore";

const mockOptimize = vi.fn();
const mockGetDomainPromptConfig = vi.fn();

vi.mock("@/lib/promptOptimizer", () => ({
  BootstrapFewShotOptimizer: class {
    optimize(...args: unknown[]) {
      return mockOptimize(...args);
    }
  }
}));

vi.mock("@/lib/config/domainPromptLoader", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/config/domainPromptLoader")>();
  return {
    ...actual,
    getDomainPromptConfig: (...args: unknown[]) =>
      mockGetDomainPromptConfig(...args)
  };
});

vi.mock("@/lib/application/promptOptimization/axOptimizationLogger", () => ({
  logAxOptimizationDone: () => undefined,
  logAxOptimizationStart: () => undefined
}));

describe("optimizeJudgePromptWithFewShot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDomainPromptConfig.mockResolvedValue({
      domain: "resume_summary",
      judgeInstruction: "judge instruction",
      passThreshold: 4
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("BootstrapFewShotOptimizer を呼び出し、最適化結果を suggestion として返す", async () => {
    mockOptimize.mockResolvedValue({
      optimizedPrompt: "judge instruction\n\n以下は参考例です:\n---\n...",
      bestScore: 0.8,
      demos: [
        {
          inputs: { userInput: "q1", generatedOutput: "a1" },
          outputs: { score: "4", reason: "good" }
        }
      ]
    });

    const feedbackRecords: HumanFeedbackRecord[] = [
      {
        id: "hf_1",
        domain: "resume_summary",
        userInput: "input A",
        generatedOutput: "output A",
        sourceType: "generated",
        judgeResult: { score: 4, reason: "ok", pass: true },
        humanScore: 4,
        humanComment: "良い",
        createdAt: "2026-03-02T00:00:00.000Z"
      }
    ];

    const { optimizeJudgePromptWithFewShot } = await import(
      "@/lib/infrastructure/ax/axFewShotJudgeOptimizer"
    );
    const result = await optimizeJudgePromptWithFewShot(
      feedbackRecords,
      "resume_summary"
    );

    expect(mockOptimize).toHaveBeenCalledTimes(1);
    const task = mockOptimize.mock.calls[0][0];
    expect(task.initialPrompt).toBe("judge instruction");
    expect(task.inputFields).toEqual(["userInput", "generatedOutput"]);
    expect(task.outputFields).toEqual(["score", "reason"]);
    expect(task.examples).toHaveLength(1);
    expect(task.examples[0].inputs.userInput).toBe("input A");
    expect(task.examples[0].inputs.generatedOutput).toBe("output A");
    expect(result.suggestion).toContain("judge instruction");
    expect(result.suggestion).toContain("以下は参考例です");
  });

  it("デモが0件の場合は初期プロンプトをそのまま返す", async () => {
    mockOptimize.mockResolvedValue({
      optimizedPrompt: "judge instruction",
      bestScore: 0.3,
      demos: []
    });

    const feedbackRecords: HumanFeedbackRecord[] = [
      {
        id: "hf_1",
        domain: "resume_summary",
        userInput: "input A",
        generatedOutput: "output A",
        sourceType: "generated",
        judgeResult: { score: 1, reason: "bad", pass: false },
        humanScore: 1,
        createdAt: "2026-03-02T00:00:00.000Z"
      }
    ];

    const { optimizeJudgePromptWithFewShot } = await import(
      "@/lib/infrastructure/ax/axFewShotJudgeOptimizer"
    );
    const result = await optimizeJudgePromptWithFewShot(
      feedbackRecords,
      "resume_summary"
    );

    expect(result.suggestion).toBe("judge instruction");
  });

  it("Judge 評価済みデータが0件の場合は案内メッセージを返す", async () => {
    const feedbackRecords: HumanFeedbackRecord[] = [];

    const { optimizeJudgePromptWithFewShot } = await import(
      "@/lib/infrastructure/ax/axFewShotJudgeOptimizer"
    );
    const result = await optimizeJudgePromptWithFewShot(
      feedbackRecords,
      "resume_summary"
    );

    expect(mockOptimize).not.toHaveBeenCalled();
    expect(result.suggestion).toContain("Judge 評価済み");
    expect(result.suggestion).toContain("最低1件必要");
  });

  it("judgeResult がないレコードは除外される", async () => {
    mockOptimize.mockResolvedValue({
      optimizedPrompt: "judge instruction",
      bestScore: 0.5,
      demos: []
    });

    const feedbackRecords: HumanFeedbackRecord[] = [
      {
        id: "hf_1",
        domain: "resume_summary",
        userInput: "input A",
        generatedOutput: "output A",
        sourceType: "generated",
        humanScore: 3,
        createdAt: "2026-03-02T00:00:00.000Z"
      }
    ];

    const { optimizeJudgePromptWithFewShot } = await import(
      "@/lib/infrastructure/ax/axFewShotJudgeOptimizer"
    );
    const result = await optimizeJudgePromptWithFewShot(
      feedbackRecords,
      "resume_summary"
    );

    expect(mockOptimize).not.toHaveBeenCalled();
    expect(result.suggestion).toContain("最低1件必要");
  });
});
