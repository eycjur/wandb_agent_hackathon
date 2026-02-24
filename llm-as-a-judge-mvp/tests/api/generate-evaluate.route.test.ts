import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { LLMProvider } from "@/lib/domain/llm";

const provider: LLMProvider = {
  name: "mock",
  models: {
    target: "target",
    judge: "judge"
  },
  generateOutput: vi.fn(),
  judgeOutput: vi.fn()
};

const getLLMProviderMock = vi.fn(() => provider);

vi.mock("@/lib/infrastructure/llmProviderFactory", () => ({
  getLLMProvider: getLLMProviderMock
}));

describe("POST /api/generate-evaluate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("不正JSONは400 INVALID_JSON", async () => {
    const { POST } = await import("@/app/api/generate-evaluate/route");

    const request = new Request("http://localhost/api/generate-evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: "{invalid json"
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("INVALID_JSON");
  });

  it("空入力は400 VALIDATION_ERROR", async () => {
    const { POST } = await import("@/app/api/generate-evaluate/route");

    const request = new Request("http://localhost/api/generate-evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ userInput: "   " })
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("正常系は拡張レスポンスを返す", async () => {
    (provider.generateOutput as ReturnType<typeof vi.fn>).mockResolvedValue(
      "summary"
    );
    (provider.judgeOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      domain: "resume_summary",
      rubricVersion: 1,
      passThreshold: 4,
      score: 5,
      reason: "good"
    });

    const { POST } = await import("@/app/api/generate-evaluate/route");

    const request = new Request("http://localhost/api/generate-evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ userInput: "resume text" })
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.domain).toBe("resume_summary");
    expect(body.rubricVersion).toBe(1);
    expect(body.passThreshold).toBe(4);
    expect(body.pass).toBe(true);
    expect(body.generatedOutput).toBe("summary");
    expect(body.score).toBe(5);
    expect(body.reason).toBe("good");
  });

  it("プロバイダータイムアウトはAppErrorを返す", async () => {
    (provider.generateOutput as ReturnType<typeof vi.fn>).mockRejectedValue(
      new AppError(504, "PROVIDER_TIMEOUT", "timeout")
    );

    const { POST } = await import("@/app/api/generate-evaluate/route");

    const request = new Request("http://localhost/api/generate-evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ userInput: "resume text" })
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(504);
    expect(body.error.code).toBe("PROVIDER_TIMEOUT");
    expect(body.error.message).toBe("timeout");
  });

  it("プロバイダー応答形式が不正なら502 PROVIDER_RESPONSE_INVALID", async () => {
    (provider.generateOutput as ReturnType<typeof vi.fn>).mockResolvedValue(
      "summary"
    );
    (provider.judgeOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      domain: "resume_summary",
      rubricVersion: 1,
      passThreshold: 4,
      score: 9,
      reason: "invalid score"
    });

    const { POST } = await import("@/app/api/generate-evaluate/route");

    const request = new Request("http://localhost/api/generate-evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ userInput: "resume text" })
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("PROVIDER_RESPONSE_INVALID");
  });
});
