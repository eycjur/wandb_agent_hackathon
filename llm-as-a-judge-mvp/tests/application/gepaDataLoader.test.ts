import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListEvaluationLogs = vi.fn();
const mockListHumanFeedback = vi.fn();
const mockFetchHumanFeedbackWithJudgeMerged = vi.fn();
const mockFetchJudgeLogsFromWeave = vi.fn();

vi.mock("@/lib/infrastructure/evaluationLogStore", () => ({
  listEvaluationLogs: (...args: unknown[]) => mockListEvaluationLogs(...args)
}));

vi.mock("@/lib/infrastructure/humanFeedbackStore", () => ({
  listHumanFeedback: (...args: unknown[]) => mockListHumanFeedback(...args)
}));

vi.mock("@/lib/infrastructure/weave/weaveClient", () => ({
  isWeaveConfigured: () => false
}));

vi.mock("@/lib/infrastructure/weave/weaveQuery", () => ({
  fetchHumanFeedbackWithJudgeMerged: (...args: unknown[]) =>
    mockFetchHumanFeedbackWithJudgeMerged(...args),
  fetchJudgeLogsFromWeave: (...args: unknown[]) =>
    mockFetchJudgeLogsFromWeave(...args)
}));

describe("gepaDataLoader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListEvaluationLogs.mockResolvedValue([]);
    mockListHumanFeedback.mockResolvedValue([]);
  });

  it("Weave judge log の sourceType 未設定時は generated にフォールバックする", async () => {
    const { toEvaluationLogRecordFromWeave } = await import(
      "@/lib/application/promptOptimization/gepaDataLoader"
    );

    const record = toEvaluationLogRecordFromWeave({
      id: "judge_1",
      domain: "resume_summary",
      score: 4,
      pass: true,
      passThreshold: 4,
      rubricVersion: 1,
      userInput: "resume text",
      generatedOutput: "summary",
      createdAt: "2026-03-01T00:00:00.000Z"
    });

    expect(record.sourceType).toBe("generated");
  });

  it("target 改善用データでは manual / generated_edited を除外する", async () => {
    mockListEvaluationLogs.mockResolvedValue([
      {
        id: "generated_1",
        domain: "resume_summary",
        userInput: "input1",
        generatedOutput: "output1",
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
        id: "manual_1",
        domain: "resume_summary",
        userInput: "input2",
        generatedOutput: "output2",
        sourceType: "manual",
        judgeResult: {
          score: 1,
          reason: "weak",
          pass: false,
          passThreshold: 4,
          rubricVersion: 1
        },
        createdAt: "2026-03-01T00:00:01.000Z"
      },
      {
        id: "edited_1",
        domain: "resume_summary",
        userInput: "input3",
        generatedOutput: "output3",
        sourceType: "generated_edited",
        judgeResult: {
          score: 3,
          reason: "weak",
          pass: false,
          passThreshold: 4,
          rubricVersion: 1
        },
        createdAt: "2026-03-01T00:00:02.000Z"
      }
    ]);

    const { loadTargetFailuresForPromptOptimization } = await import(
      "@/lib/application/promptOptimization/gepaDataLoader"
    );

    const result = await loadTargetFailuresForPromptOptimization(
      "resume_summary",
      10
    );

    expect(result.map((record) => record.id)).toEqual(["generated_1"]);
  });
});
