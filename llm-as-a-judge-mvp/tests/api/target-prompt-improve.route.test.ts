import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListFailedEvaluations = vi.fn();
const mockGenerateTargetPromptImprovement = vi.fn();
const mockGetDomainPromptConfig = vi.fn();
const mockIsWeaveConfigured = vi.fn();
const mockFetchJudgeLogsFromWeave = vi.fn();

vi.mock("@/lib/infrastructure/evaluationLogStore", () => ({
  listFailedEvaluations: (...args: unknown[]) => mockListFailedEvaluations(...args)
}));

vi.mock("@/lib/infrastructure/weave/weaveClient", () => ({
  isWeaveConfigured: () => mockIsWeaveConfigured()
}));

vi.mock("@/lib/infrastructure/weave/weaveQuery", () => ({
  fetchJudgeLogsFromWeave: (...args: unknown[]) => mockFetchJudgeLogsFromWeave(...args)
}));

vi.mock("@/lib/application/targetPromptImproveUseCase", () => ({
  generateTargetPromptImprovement: (...args: unknown[]) =>
    mockGenerateTargetPromptImprovement(...args)
}));

vi.mock("@/lib/config/domainPromptLoader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/domainPromptLoader")>();
  return {
    ...actual,
    getDomainPromptConfig: (...args: unknown[]) => mockGetDomainPromptConfig(...args)
  };
});

describe("POST /api/target-prompt/improve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWeaveConfigured.mockReturnValue(false);
    mockGetDomainPromptConfig.mockResolvedValue({ passThreshold: 4 });
    mockListFailedEvaluations.mockResolvedValue([
      {
        id: "eval_1",
        domain: "resume_summary",
        userInput: "input",
        generatedOutput: "output",
        judgeResult: {
          score: 2,
          reason: "要約が不十分",
          pass: false,
          passThreshold: 4,
          rubricVersion: 1
        },
        createdAt: "2024-01-01T00:00:00.000Z"
      }
    ]);
    mockGenerateTargetPromptImprovement.mockResolvedValue({
      suggestion: "改善版の target instruction テキスト",
      analysisSummary: "実績の数値化が不足している"
    });
  });

  it("不正JSONは400 INVALID_JSON", async () => {
    const { POST } = await import("@/app/api/target-prompt/improve/route");

    const request = new Request("http://localhost/api/target-prompt/improve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid"
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("INVALID_JSON");
  });

  it("正常系は200でsuggestionとanalysisSummaryを返す", async () => {
    const { POST } = await import("@/app/api/target-prompt/improve/route");

    const request = new Request("http://localhost/api/target-prompt/improve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "resume_summary" })
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.suggestion).toBe("改善版の target instruction テキスト");
    expect(body.analysisSummary).toBe("実績の数値化が不足している");
    expect(mockListFailedEvaluations).toHaveBeenCalledWith({
      domain: "resume_summary",
      limit: 10,
      minScore: 4
    });
  });

  it("Weave設定時はfetchJudgeLogsFromWeaveから取得して改善案を生成", async () => {
    mockIsWeaveConfigured.mockReturnValue(true);
    mockFetchJudgeLogsFromWeave.mockResolvedValue([
      {
        id: "jl_1",
        domain: "resume_summary",
        score: 2,
        pass: false,
        passThreshold: 4,
        rubricVersion: 1,
        userInput: "input",
        generatedOutput: "output",
        reason: "要約が不十分",
        createdAt: "2024-01-01T00:00:00.000Z"
      }
    ]);

    const { POST } = await import("@/app/api/target-prompt/improve/route");

    const request = new Request("http://localhost/api/target-prompt/improve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "resume_summary" })
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.suggestion).toBe("改善版の target instruction テキスト");
    expect(mockFetchJudgeLogsFromWeave).toHaveBeenCalledWith({
      domain: "resume_summary",
      limit: 20
    });
    expect(mockListFailedEvaluations).not.toHaveBeenCalled();
  });
});
