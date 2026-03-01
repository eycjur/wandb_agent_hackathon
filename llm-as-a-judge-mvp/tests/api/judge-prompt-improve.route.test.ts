import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadJudgeFeedbackForPromptOptimization = vi.fn();
const mockGenerateJudgePromptImprovement = vi.fn();

vi.mock("@/lib/application/promptOptimization/gepaDataLoader", () => ({
  loadJudgeFeedbackForPromptOptimization: (...args: unknown[]) =>
    mockLoadJudgeFeedbackForPromptOptimization(...args)
}));

vi.mock("@/lib/application/judgePromptImproveUseCase", () => ({
  generateJudgePromptImprovement: (...args: unknown[]) =>
    mockGenerateJudgePromptImprovement(...args)
}));

describe("POST /api/judge-prompt/improve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadJudgeFeedbackForPromptOptimization.mockResolvedValue([
      {
        id: "hf_1",
        domain: "resume_summary",
        userInput: "input",
        generatedOutput: "output",
        judgeResult: { score: 4, reason: "ok", pass: true },
        humanScore: 2,
        humanComment: "too high",
        createdAt: "2024-01-01T00:00:00.000Z"
      }
    ]);
    mockGenerateJudgePromptImprovement.mockResolvedValue({
      suggestion: "改善版の instruction_template テキスト",
      analysisSummary: "Judge が高めに評価する傾向がある"
    });
  });

  it("不正JSONは400 INVALID_JSON", async () => {
    const { POST } = await import("@/app/api/judge-prompt/improve/route");

    const request = new Request("http://localhost/api/judge-prompt/improve", {
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
    const { POST } = await import("@/app/api/judge-prompt/improve/route");

    const request = new Request("http://localhost/api/judge-prompt/improve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "resume_summary" })
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.suggestion).toBe("改善版の instruction_template テキスト");
    expect(body.analysisSummary).toBe("Judge が高めに評価する傾向がある");
    expect(mockLoadJudgeFeedbackForPromptOptimization).toHaveBeenCalledWith(
      "resume_summary",
      10
    );
  });

  it("feedbackLimitを指定できる", async () => {
    const { POST } = await import("@/app/api/judge-prompt/improve/route");

    const request = new Request("http://localhost/api/judge-prompt/improve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "resume_summary", feedbackLimit: 5 })
    });

    await POST(request as never);

    expect(mockLoadJudgeFeedbackForPromptOptimization).toHaveBeenCalledWith(
      "resume_summary",
      5
    );
  });
});
