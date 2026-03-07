import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSave = vi.fn();
const mockList = vi.fn();

vi.mock("@/lib/infrastructure/humanFeedbackStore", () => ({
  saveHumanFeedback: (...args: unknown[]) => mockSave(...args),
  listHumanFeedback: (...args: unknown[]) => mockList(...args)
}));

describe("POST /api/human-feedback", () => {
  const validBody = {
    domain: "resume_summary",
    userInput: "resume text",
    generatedOutput: "summary",
    sourceType: "manual",
    judgeResult: { score: 4, reason: "good", pass: true },
    humanScore: 5
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSave.mockResolvedValue({
      id: "hf_123",
      createdAt: "2024-01-01T00:00:00.000Z"
    });
  });

  it("不正JSONは400 INVALID_JSON", async () => {
    const { POST } = await import("@/app/api/human-feedback/route");

    const request = new Request("http://localhost/api/human-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid"
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("INVALID_JSON");
  });

  it("humanScore不足は400 VALIDATION_ERROR", async () => {
    const { POST } = await import("@/app/api/human-feedback/route");

    const request = new Request("http://localhost/api/human-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, humanScore: undefined })
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("正常系は201でidとcreatedAtを返す", async () => {
    const { POST } = await import("@/app/api/human-feedback/route");

    const request = new Request("http://localhost/api/human-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody)
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.id).toBe("hf_123");
    expect(body.createdAt).toBeDefined();
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "resume_summary",
        sourceType: "manual",
        humanScore: 5,
        judgeResult: { score: 4, reason: "good", pass: true }
      })
    );
  });
});

describe("GET /api/human-feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([]);
  });

  it("正常系は200でrecordsを返す", async () => {
    mockList.mockResolvedValue([
      {
        id: "hf_1",
        domain: "resume_summary",
        userInput: "resume text",
        generatedOutput: "summary",
        sourceType: "generated",
        judgeResult: { score: 4, reason: "ok", pass: true },
        humanScore: 4,
        createdAt: "2024-01-01T00:00:00.000Z"
      }
    ]);

    const { GET } = await import("@/app/api/human-feedback/route");

    const request = new Request("http://localhost/api/human-feedback");

    const response = await GET(request as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.records).toHaveLength(1);
    expect(body.records[0].id).toBe("hf_1");
    expect(mockList).toHaveBeenCalledWith({ limit: 50 });
  });

  it("domainクエリでフィルタする", async () => {
    const { GET } = await import("@/app/api/human-feedback/route");

    const request = new Request("http://localhost/api/human-feedback?domain=resume_summary");

    await GET(request as never);

    expect(mockList).toHaveBeenCalledWith({
      domain: "resume_summary",
      limit: 50
    });
  });
});
