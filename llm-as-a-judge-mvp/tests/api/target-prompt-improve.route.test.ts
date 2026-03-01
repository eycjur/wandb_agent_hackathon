import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadTargetFailuresForPromptOptimization = vi.fn();
const mockGenerateTargetPromptImprovement = vi.fn();

vi.mock("@/lib/application/promptOptimization/gepaDataLoader", () => ({
  loadTargetFailuresForPromptOptimization: (...args: unknown[]) =>
    mockLoadTargetFailuresForPromptOptimization(...args)
}));

vi.mock("@/lib/application/targetPromptImproveUseCase", () => ({
  generateTargetPromptImprovement: (...args: unknown[]) =>
    mockGenerateTargetPromptImprovement(...args)
}));

describe("POST /api/target-prompt/improve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadTargetFailuresForPromptOptimization.mockResolvedValue([
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
    expect(mockLoadTargetFailuresForPromptOptimization).toHaveBeenCalledWith(
      "resume_summary",
      10,
      undefined
    );
  });

  it("failedLimit/minScoreをローダーへ引き渡す", async () => {
    const { POST } = await import("@/app/api/target-prompt/improve/route");

    const request = new Request("http://localhost/api/target-prompt/improve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "resume_summary",
        failedLimit: 5,
        minScore: 3
      })
    });

    await POST(request as never);

    expect(mockLoadTargetFailuresForPromptOptimization).toHaveBeenCalledWith(
      "resume_summary",
      5,
      3
    );
  });
});
