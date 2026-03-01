import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { AppError } from "@/lib/errors";

// Mock MCP_TIMEOUT_MS to a short value so the test completes quickly
vi.mock("@/lib/config/llm", () => ({
  JUDGE_MODEL: "gemini-2.5-pro",
  MCP_TIMEOUT_MS: 100,
}));

const mockConnect = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);

// Mock MCP Client with controllable connect/close
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function () {
    return { connect: mockConnect, close: mockClose };
  }),
}));

// Mock MCP transport (no-op)
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

// Mock Gemini SDK to avoid real API calls
vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return {
      models: {
        generateContent: vi
          .fn()
          .mockResolvedValue({ text: "response", automaticFunctionCallingHistory: [] }),
      },
    };
  }),
  mcpToTool: vi.fn().mockReturnValue({}),
}));

import { generateTextWithWandbMcp } from "@/lib/infrastructure/gemini/geminiMcpGenerator";

describe("generateTextWithWandbMcp", () => {
  beforeEach(() => {
    process.env.WANDB_API_KEY = "test-wandb-key";
    process.env.GEMINI_API_KEY = "test-gemini-key";
  });

  afterEach(() => {
    delete process.env.WANDB_API_KEY;
    delete process.env.GEMINI_API_KEY;
    vi.clearAllMocks();
  });

  it("connect がタイムアウトした場合 PROVIDER_TIMEOUT(504) を投げる", async () => {
    // connect() never resolves — simulates a hanging connection
    mockConnect.mockImplementation(() => new Promise<void>(() => {}));

    const error = await generateTextWithWandbMcp("test prompt").catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(504);
    expect(error.code).toBe("PROVIDER_TIMEOUT");
  });
});

