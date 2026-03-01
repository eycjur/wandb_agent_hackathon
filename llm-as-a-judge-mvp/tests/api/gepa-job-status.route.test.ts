import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetById = vi.fn();

vi.mock("@/lib/application/gepaJobService", () => ({
  getGepaJobService: () => ({
    getById: (...args: unknown[]) => mockGetById(...args)
  })
}));

describe("GET /api/gepa-jobs/[jobId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("未知のjobIdは404", async () => {
    mockGetById.mockReturnValue(null);
    const { GET } = await import("@/app/api/gepa-jobs/[jobId]/route");
    const request = new Request("http://localhost/api/gepa-jobs/unknown", {
      method: "GET"
    });

    const response = await GET(request as never, {
      params: Promise.resolve({ jobId: "unknown" })
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("正常系はジョブ状態を返す", async () => {
    mockGetById.mockReturnValue({
      jobId: "gepa_job_1",
      kind: "judge",
      domain: "resume_summary",
      status: "succeeded",
      llmProvider: "ax",
      axMethod: "gepa",
      feedbackLimit: 10,
      failedLimit: 10,
      createdAt: "2026-03-01T00:00:00.000Z",
      startedAt: "2026-03-01T00:00:01.000Z",
      finishedAt: "2026-03-01T00:00:05.000Z",
      result: {
        suggestion: "改善案",
        analysisSummary: "分析サマリー",
        currentPrompt: "現在プロンプト"
      }
    });
    const { GET } = await import("@/app/api/gepa-jobs/[jobId]/route");
    const request = new Request("http://localhost/api/gepa-jobs/gepa_job_1", {
      method: "GET"
    });

    const response = await GET(request as never, {
      params: Promise.resolve({ jobId: "gepa_job_1" })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.jobId).toBe("gepa_job_1");
    expect(body.status).toBe("succeeded");
    expect(body.result.suggestion).toBe("改善案");
    expect(mockGetById).toHaveBeenCalledWith("gepa_job_1");
  });
});
