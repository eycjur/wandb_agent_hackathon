import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";

const getDomainPromptConfigMock = vi.fn();

vi.mock("@/lib/config/domainPromptLoader", () => ({
  getDomainPromptConfig: getDomainPromptConfigMock,
  SUPPORTED_DOMAINS: ["resume_summary", "resume_detail", "self_pr"]
}));

function createRequest(domain?: string) {
  const url = domain
    ? `http://localhost/api/domain-config?domain=${domain}`
    : "http://localhost/api/domain-config";
  return new Request(url) as never;
}

describe("GET /api/domain-config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("設定を返す（resume_summary）", async () => {
    getDomainPromptConfigMock.mockResolvedValue({
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
    const response = await GET(createRequest("resume_summary"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.domain).toBe("resume_summary");
    expect(body.rubricVersion).toBe(1);
    expect(body.passThreshold).toBe(4);
    expect(body.samples).toHaveLength(1);
    expect(getDomainPromptConfigMock).toHaveBeenCalledWith("resume_summary");
  });

  it("domain未指定時はresume_summaryで取得", async () => {
    getDomainPromptConfigMock.mockResolvedValue({
      domain: "resume_summary",
      rubricVersion: 1,
      passThreshold: 4,
      targetInstruction: "target",
      judgeInstruction: "judge",
      judgeRubric: ["r1"],
      samples: [{ title: "s", input: "i" }]
    });

    const { GET } = await import("@/app/api/domain-config/route");
    const response = await GET(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.domain).toBe("resume_summary");
    expect(getDomainPromptConfigMock).toHaveBeenCalledWith("resume_summary");
  });

  it("設定エラーを返す", async () => {
    getDomainPromptConfigMock.mockRejectedValue(
      new AppError(500, "CONFIG_ERROR", "設定読み込み失敗")
    );

    const { GET } = await import("@/app/api/domain-config/route");
    const response = await GET(createRequest("resume_summary"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("CONFIG_ERROR");
    expect(body.error.message).toBe("設定読み込み失敗");
  });
});
