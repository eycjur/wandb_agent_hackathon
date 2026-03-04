import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsWeaveConfigured = vi.fn();
const mockFetchHumanFeedbackWithJudgeMerged = vi.fn();
const mockFetchJudgeLogsFromWeave = vi.fn();
const mockListHumanFeedback = vi.fn();
const mockListFailedEvaluations = vi.fn();
const mockListEvaluationLogs = vi.fn();
const mockGetDomainPromptConfig = vi.fn();

vi.mock("@/lib/infrastructure/weave/weaveClient", () => ({
  isWeaveConfigured: () => mockIsWeaveConfigured()
}));

vi.mock("@/lib/infrastructure/weave/weaveQuery", () => ({
  fetchHumanFeedbackWithJudgeMerged: (...args: unknown[]) =>
    mockFetchHumanFeedbackWithJudgeMerged(...args),
  fetchJudgeLogsFromWeave: (...args: unknown[]) => mockFetchJudgeLogsFromWeave(...args)
}));

vi.mock("@/lib/infrastructure/humanFeedbackStore", () => ({
  listHumanFeedback: (...args: unknown[]) => mockListHumanFeedback(...args)
}));

vi.mock("@/lib/infrastructure/evaluationLogStore", () => ({
  listFailedEvaluations: (...args: unknown[]) => mockListFailedEvaluations(...args),
  listEvaluationLogs: (...args: unknown[]) => mockListEvaluationLogs(...args)
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

describe("gepaDataLoader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDomainPromptConfig.mockResolvedValue({ passThreshold: 4 });
  });

  it("Weaveが有効で正常応答が空配列の場合はローカルへフォールバックしない（judge）", async () => {
    mockIsWeaveConfigured.mockReturnValue(true);
    mockFetchHumanFeedbackWithJudgeMerged.mockResolvedValue([]);
    mockListHumanFeedback.mockResolvedValue([
      {
        id: "hf_1",
        domain: "resume_summary",
        userInput: "input",
        generatedOutput: "output",
        humanScore: 3,
        createdAt: "2024-01-01T00:00:00.000Z"
      }
    ]);

    const { loadJudgeFeedbackForPromptOptimization } = await import(
      "@/lib/application/promptOptimization/gepaDataLoader"
    );

    const records = await loadJudgeFeedbackForPromptOptimization(
      "resume_summary",
      10
    );

    expect(records).toEqual([]);
    expect(mockListHumanFeedback).not.toHaveBeenCalled();
    expect(mockFetchHumanFeedbackWithJudgeMerged).toHaveBeenCalledWith({
      domain: "resume_summary",
      limit: 10,
      throwOnError: true
    });
  });

  it("Weave取得エラー時のみローカルへフォールバックする（judge）", async () => {
    mockIsWeaveConfigured.mockReturnValue(true);
    mockFetchHumanFeedbackWithJudgeMerged.mockRejectedValue(
      new Error("weave error")
    );
    mockListHumanFeedback.mockResolvedValue([
      {
        id: "hf_1",
        domain: "resume_summary",
        userInput: "input",
        generatedOutput: "output",
        humanScore: 3,
        createdAt: "2024-01-01T00:00:00.000Z"
      }
    ]);

    const { loadJudgeFeedbackForPromptOptimization } = await import(
      "@/lib/application/promptOptimization/gepaDataLoader"
    );

    const records = await loadJudgeFeedbackForPromptOptimization(
      "resume_summary",
      10
    );

    expect(records).toHaveLength(1);
    expect(mockFetchHumanFeedbackWithJudgeMerged).toHaveBeenCalledWith({
      domain: "resume_summary",
      limit: 10,
      throwOnError: true
    });
    expect(mockListHumanFeedback).toHaveBeenCalledWith({
      domain: "resume_summary",
      limit: 10
    });
  });

  it("Weave成功時はtarget側もローカルへフォールバックしない", async () => {
    mockIsWeaveConfigured.mockReturnValue(true);
    mockFetchJudgeLogsFromWeave.mockResolvedValue([]);
    mockListFailedEvaluations.mockResolvedValue([
      {
        id: "eval_1",
        domain: "resume_summary",
        userInput: "input",
        generatedOutput: "output",
        judgeResult: {
          score: 2,
          reason: "bad",
          pass: false,
          passThreshold: 4,
          rubricVersion: 1
        },
        createdAt: "2024-01-01T00:00:00.000Z"
      }
    ]);

    const { loadTargetFailuresForPromptOptimization } = await import(
      "@/lib/application/promptOptimization/gepaDataLoader"
    );

    const records = await loadTargetFailuresForPromptOptimization(
      "resume_summary",
      10
    );

    expect(records).toEqual([]);
    expect(mockListFailedEvaluations).not.toHaveBeenCalled();
    expect(mockFetchJudgeLogsFromWeave).toHaveBeenCalledWith({
      domain: "resume_summary",
      limit: 100,
      throwOnError: true
    });
  });

  it("Weave成功時は不合格が1件以上あれば、合格データも含めて返す（target）", async () => {
    mockIsWeaveConfigured.mockReturnValue(true);
    mockFetchJudgeLogsFromWeave.mockResolvedValue([
      {
        id: "eval_0",
        domain: "resume_summary",
        userInput: "bad input",
        generatedOutput: "bad output",
        score: 2,
        reason: "bad",
        pass: false,
        passThreshold: 4,
        rubricVersion: 1,
        createdAt: "2024-01-02T00:00:00.000Z"
      },
      {
        id: "eval_1",
        domain: "resume_summary",
        userInput: "input",
        generatedOutput: "output",
        score: 5,
        reason: "good",
        pass: true,
        passThreshold: 4,
        rubricVersion: 1,
        createdAt: "2024-01-01T00:00:00.000Z"
      }
    ]);

    const { loadTargetFailuresForPromptOptimization } = await import(
      "@/lib/application/promptOptimization/gepaDataLoader"
    );

    const records = await loadTargetFailuresForPromptOptimization(
      "resume_summary",
      10
    );

    expect(records).toHaveLength(2);
    expect(records.some((r) => r.judgeResult.pass === false)).toBe(true);
    expect(records.some((r) => r.judgeResult.pass === true)).toBe(true);
    expect(mockListFailedEvaluations).not.toHaveBeenCalled();
    expect(mockListEvaluationLogs).not.toHaveBeenCalled();
  });

  it("Weave成功時は不合格が0件なら空配列を返す（target）", async () => {
    mockIsWeaveConfigured.mockReturnValue(true);
    mockFetchJudgeLogsFromWeave.mockResolvedValue([
      {
        id: "eval_1",
        domain: "resume_summary",
        userInput: "input",
        generatedOutput: "output",
        score: 5,
        reason: "good",
        pass: true,
        passThreshold: 4,
        rubricVersion: 1,
        createdAt: "2024-01-01T00:00:00.000Z"
      }
    ]);

    const { loadTargetFailuresForPromptOptimization } = await import(
      "@/lib/application/promptOptimization/gepaDataLoader"
    );

    const records = await loadTargetFailuresForPromptOptimization(
      "resume_summary",
      10
    );

    expect(records).toEqual([]);
    expect(mockListFailedEvaluations).not.toHaveBeenCalled();
    expect(mockListEvaluationLogs).not.toHaveBeenCalled();
  });
});
