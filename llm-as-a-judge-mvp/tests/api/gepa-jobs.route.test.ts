import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnqueue = vi.fn();

vi.mock("@/lib/application/gepaJobService", () => ({
  getGepaJobService: () => ({
    enqueue: (...args: unknown[]) => mockEnqueue(...args)
  })
}));

describe("POST /api/gepa-jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueue.mockReturnValue({
      jobId: "gepa_job_1",
      kind: "judge",
      domain: "resume_summary",
      status: "queued"
    });
  });

  it("不正JSONは400 INVALID_JSON", async () => {
    const { POST } = await import("@/app/api/gepa-jobs/route");
    const request = new Request("http://localhost/api/gepa-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid"
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("INVALID_JSON");
  });

  it("GEPA条件を満たさない場合は400 VALIDATION_ERROR", async () => {
    const { POST } = await import("@/app/api/gepa-jobs/route");
    const request = new Request("http://localhost/api/gepa-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "judge",
        domain: "resume_summary",
        llmProvider: "gemini",
        axMethod: "few-shot"
      })
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("正常系は202でjobIdを返す", async () => {
    const { POST } = await import("@/app/api/gepa-jobs/route");
    const request = new Request("http://localhost/api/gepa-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "judge",
        domain: "resume_summary",
        llmProvider: "ax",
        axMethod: "gepa"
      })
    });

    const response = await POST(request as never);
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.jobId).toBe("gepa_job_1");
    expect(body.kind).toBe("judge");
    expect(body.domain).toBe("resume_summary");
    expect(body.status).toBe("queued");
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "judge",
        domain: "resume_summary",
        feedbackLimit: 10,
        failedLimit: 10,
        llmProvider: "ax",
        axMethod: "gepa"
      })
    );
  });
});
