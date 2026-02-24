import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { LLMProvider } from "@/lib/domain/llm";
import { MAX_GENERATED_OUTPUT_CHARS } from "@/lib/config/app";

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

describe("POST /api/generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("不正JSONは400 INVALID_JSON", async () => {
    const { POST } = await import("@/app/api/generate/route");

    const request = new Request("http://localhost/api/generate", {
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
    const { POST } = await import("@/app/api/generate/route");

    const request = new Request("http://localhost/api/generate", {
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

  it("正常系はgeneratedOutputを返す", async () => {
    (provider.generateOutput as ReturnType<typeof vi.fn>).mockResolvedValue(
      "summary"
    );

    const { POST } = await import("@/app/api/generate/route");

    const request = new Request("http://localhost/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ userInput: "resume text" })
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.generatedOutput).toBe("summary");
  });

  it("プロバイダーエラーはAppErrorを返す", async () => {
    (provider.generateOutput as ReturnType<typeof vi.fn>).mockRejectedValue(
      new AppError(504, "PROVIDER_TIMEOUT", "timeout")
    );

    const { POST } = await import("@/app/api/generate/route");

    const request = new Request("http://localhost/api/generate", {
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
      "a".repeat(MAX_GENERATED_OUTPUT_CHARS + 1)
    );

    const { POST } = await import("@/app/api/generate/route");

    const request = new Request("http://localhost/api/generate", {
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
