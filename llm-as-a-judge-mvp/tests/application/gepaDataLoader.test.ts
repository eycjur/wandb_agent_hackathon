import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsWeaveConfigured = vi.fn();
const mockFetchHumanFeedbackWithJudgeMerged = vi.fn();
const mockFetchJudgeLogsFromWeave = vi.fn();
const mockListHumanFeedback = vi.fn();
const mockListFailedEvaluations = vi.fn();
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
  listFailedEvaluations: (...args: unknown[]) => mockListFailedEvaluations(...args)
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
      limit: 10
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
      limit: 10
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
      limit: 20
    });
  });
});
