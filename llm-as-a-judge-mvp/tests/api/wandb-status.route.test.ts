import { beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = process.env;

vi.mock("@/lib/infrastructure/weave/weaveLogger", () => ({
  isWeaveConfigured: vi.fn(),
  getWeaveDashboardUrl: vi.fn(() => "https://wandb.ai/test-entity/test-project")
}));

describe("GET /api/wandb-status", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  it("WANDB_API_KEY設定時はconfigured: true", async () => {
    const { isWeaveConfigured } = await import("@/lib/infrastructure/weave/weaveLogger");
    (isWeaveConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { GET } = await import("@/app/api/wandb-status/route");
    const request = new Request("http://localhost/api/wandb-status");
    const response = await GET(request as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.dashboardUrl).toBe("https://wandb.ai/test-entity/test-project");
  });

  it("WANDB_API_KEY未設定時はconfigured: false", async () => {
    const { isWeaveConfigured } = await import("@/lib/infrastructure/weave/weaveLogger");
    (isWeaveConfigured as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { GET } = await import("@/app/api/wandb-status/route");
    const request = new Request("http://localhost/api/wandb-status");
    const response = await GET(request as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.dashboardUrl).toBeNull();
  });
});
