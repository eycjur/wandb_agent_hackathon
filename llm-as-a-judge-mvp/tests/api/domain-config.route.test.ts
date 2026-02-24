import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const getResumeSummaryPromptConfigMock = vi.fn();

vi.mock("@/lib/config/resumeSummaryPromptLoader", () => ({
  getResumeSummaryPromptConfig: getResumeSummaryPromptConfigMock
}));

describe("GET /api/domain-config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("設定を返す", async () => {
    getResumeSummaryPromptConfigMock.mockResolvedValue({
      domain: "resume_summary",
      rubricVersion: 1,
      passThreshold: 4,
      targetInstruction: "target",
      judgeInstruction: "judge",
      judgeRubric: ["r1"],
      samples: [
        {
          title: "sample",
          input: "input"
        }
      ]
    });

    const { GET } = await import("@/app/api/domain-config/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.domain).toBe("resume_summary");
    expect(body.rubricVersion).toBe(1);
    expect(body.passThreshold).toBe(4);
    expect(body.samples).toHaveLength(1);
  });

  it("設定エラーを返す", async () => {
    getResumeSummaryPromptConfigMock.mockRejectedValue(
      new AppError(500, "CONFIG_ERROR", "設定読み込み失敗")
    );

    const { GET } = await import("@/app/api/domain-config/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("CONFIG_ERROR");
    expect(body.error.message).toBe("設定読み込み失敗");
  });
});
