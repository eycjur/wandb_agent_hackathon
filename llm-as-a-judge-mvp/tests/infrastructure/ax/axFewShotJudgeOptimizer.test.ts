import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HumanFeedbackRecord } from "@/lib/infrastructure/humanFeedbackStore";

const mockCompile = vi.fn();
const mockGetDomainPromptConfig = vi.fn();
const mockProgram = {
  getId: vi.fn(() => "judge_program_test"),
  setDemos: vi.fn(),
  applyOptimization: vi.fn(),
  getSignature: vi.fn(() => ({
    getInputFields: () => [
      { name: "userInput", title: "userInput", isInternal: false },
      { name: "generatedOutput", title: "generatedOutput", isInternal: false }
    ],
    getOutputFields: () => [
      { name: "score", title: "score", isInternal: false },
      { name: "reason", title: "reason", isInternal: false }
    ],
    getDescription: () => "judge instruction"
  }))
};

vi.mock("@ax-llm/ax", () => ({
  ai: vi.fn(() => ({})),
  ax: vi.fn(() => mockProgram),
  AxAIGoogleGeminiModel: {},
  AxBootstrapFewShot: class {
    compile(...args: unknown[]) {
      return mockCompile(...args);
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
  createAxOptimizerEventLogger: () => () => undefined,
  createAxProgressLogger: () => () => undefined,
  createAxMetricLogger: () => () => undefined,
  logAxOptimizationDone: () => undefined,
  logAxOptimizationStart: () => undefined
}));

describe("optimizeJudgePromptWithFewShot", () => {
  const originalGeminiApiKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = "test_key";
    mockGetDomainPromptConfig.mockResolvedValue({
      domain: "resume_summary",
      judgeInstruction: "judge instruction",
      passThreshold: 4
    });
  });

  afterEach(() => {
    if (originalGeminiApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalGeminiApiKey;
    }
  });

  it("最終few-shotデモは人間スコア/コメントで上書きされる", async () => {
    mockCompile.mockResolvedValue({
      bestScore: 0.8,
      demos: [
        {
          programId: "judge_program_test",
          traces: [
            {
              userInput: "input A",
              generatedOutput: "output A",
              score: 0,
              reason: "LLM reason"
            }
          ]
        }
      ]
    });

    const feedbackRecords: HumanFeedbackRecord[] = [
      {
        id: "hf_1",
        domain: "resume_summary",
        userInput: "input A",
        generatedOutput: "output A",
        judgeResult: { score: 1, reason: "bad", pass: false },
        humanScore: 5,
        humanComment: "人間コメントA",
        createdAt: "2026-03-02T00:00:00.000Z"
      },
      {
        id: "hf_2",
        domain: "resume_summary",
        userInput: "input B",
        generatedOutput: "output B",
        judgeResult: { score: 4, reason: "ok", pass: true },
        humanScore: 2,
        humanComment: "人間コメントB",
        createdAt: "2026-03-01T00:00:00.000Z"
      }
    ];

    const { optimizeJudgePromptWithFewShot } = await import(
      "@/lib/infrastructure/ax/axFewShotJudgeOptimizer"
    );
    const result = await optimizeJudgePromptWithFewShot(
      feedbackRecords,
      "resume_summary"
    );

    const demosArg = mockProgram.setDemos.mock.calls.at(-1)?.[0] as Array<{
      traces: Array<{ score: number; reason: string }>;
    }>;

    expect(demosArg[0]?.traces[0]?.score).toBe(5);
    expect(demosArg[0]?.traces[0]?.reason).toBe("人間コメントA");
    expect(result.suggestion).toContain("score: 5");
    expect(result.suggestion).toContain("reason: 人間コメントA");
    expect(result.suggestion).not.toContain("LLM reason");
  });

  it("最適化候補に一致がなくても人間評価データからデモを補完する", async () => {
    mockCompile.mockResolvedValue({
      bestScore: 0.5,
      demos: [
        {
          programId: "judge_program_test",
          traces: [
            {
              userInput: "unknown input",
              generatedOutput: "unknown output",
              score: 3,
              reason: "LLM reason"
            }
          ]
        }
      ]
    });

    const feedbackRecords: HumanFeedbackRecord[] = [
      {
        id: "hf_old",
        domain: "resume_summary",
        userInput: "input old",
        generatedOutput: "output old",
        judgeResult: { score: 2, reason: "old", pass: false },
        humanScore: 1,
        humanComment: "古いコメント",
        createdAt: "2026-03-01T00:00:00.000Z"
      },
      {
        id: "hf_new",
        domain: "resume_summary",
        userInput: "input new",
        generatedOutput: "output new",
        judgeResult: { score: 2, reason: "new", pass: false },
        humanScore: 4,
        humanComment: "新しいコメント",
        createdAt: "2026-03-03T00:00:00.000Z"
      }
    ];

    const { optimizeJudgePromptWithFewShot } = await import(
      "@/lib/infrastructure/ax/axFewShotJudgeOptimizer"
    );
    const result = await optimizeJudgePromptWithFewShot(
      feedbackRecords,
      "resume_summary"
    );

    const demosArg = mockProgram.setDemos.mock.calls.at(-1)?.[0] as Array<{
      traces: Array<{ score: number; reason: string }>;
    }>;

    expect(demosArg[0]?.traces[0]?.score).toBe(4);
    expect(demosArg[0]?.traces[0]?.reason).toBe("新しいコメント");
    expect(result.analysisSummary).toContain("最適化候補一致: 0件");
  });

  it("humanComment が空の場合は既定理由を使う", async () => {
    mockCompile.mockResolvedValue({
      bestScore: 0.7,
      demos: [
        {
          programId: "judge_program_test",
          traces: [
            {
              userInput: "input C",
              generatedOutput: "output C",
              score: 2,
              reason: "LLM reason"
            }
          ]
        }
      ]
    });

    const feedbackRecords: HumanFeedbackRecord[] = [
      {
        id: "hf_c",
        domain: "resume_summary",
        userInput: "input C",
        generatedOutput: "output C",
        judgeResult: { score: 2, reason: "judge", pass: false },
        humanScore: 3,
        createdAt: "2026-03-03T00:00:00.000Z"
      }
    ];

    const { optimizeJudgePromptWithFewShot } = await import(
      "@/lib/infrastructure/ax/axFewShotJudgeOptimizer"
    );
    const result = await optimizeJudgePromptWithFewShot(
      feedbackRecords,
      "resume_summary"
    );

    const demosArg = mockProgram.setDemos.mock.calls.at(-1)?.[0] as Array<{
      traces: Array<{ score: number; reason: string }>;
    }>;

    expect(demosArg[0]?.traces[0]?.score).toBe(3);
    expect(demosArg[0]?.traces[0]?.reason).toBe(
      "人間評価スコアに整合する理由を返す"
    );
    expect(result.suggestion).toContain("reason: 人間評価スコアに整合する理由を返す");
  });

  it("同一キーの重複レコードは createdAt が新しい人間評価を採用する", async () => {
    mockCompile.mockResolvedValue({
      bestScore: 0.9,
      demos: [
        {
          programId: "judge_program_test",
          traces: [
            {
              userInput: "input D",
              generatedOutput: "output D",
              score: 1,
              reason: "LLM reason"
            }
          ]
        }
      ]
    });

    const feedbackRecords: HumanFeedbackRecord[] = [
      {
        id: "hf_old",
        domain: "resume_summary",
        userInput: "input D",
        generatedOutput: "output D",
        judgeResult: { score: 1, reason: "old judge", pass: false },
        humanScore: 1,
        humanComment: "古い人間コメント",
        createdAt: "2026-03-01T00:00:00.000Z"
      },
      {
        id: "hf_new",
        domain: "resume_summary",
        userInput: "input D",
        generatedOutput: "output D",
        judgeResult: { score: 1, reason: "new judge", pass: false },
        humanScore: 5,
        humanComment: "新しい人間コメント",
        createdAt: "2026-03-04T00:00:00.000Z"
      }
    ];

    const { optimizeJudgePromptWithFewShot } = await import(
      "@/lib/infrastructure/ax/axFewShotJudgeOptimizer"
    );
    const result = await optimizeJudgePromptWithFewShot(
      feedbackRecords,
      "resume_summary"
    );

    const demosArg = mockProgram.setDemos.mock.calls.at(-1)?.[0] as Array<{
      traces: Array<{ score: number; reason: string }>;
    }>;

    expect(demosArg[0]?.traces[0]?.score).toBe(5);
    expect(demosArg[0]?.traces[0]?.reason).toBe("新しい人間コメント");
    expect(result.suggestion).toContain("score: 5");
    expect(result.suggestion).toContain("reason: 新しい人間コメント");
  });
});
