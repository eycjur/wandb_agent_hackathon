import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infrastructure/weave/promptManager", () => ({
  isWeavePromptConfigured: vi.fn(),
  publishPromptToWeave: vi.fn().mockResolvedValue(undefined),
  fetchPromptFromWeave: vi.fn().mockResolvedValue(null)
}));

describe("POST /api/prompts/sync-to-weave", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("WANDB_API_KEY未設定時は400 WEAVE_NOT_CONFIGURED", async () => {
    const { isWeavePromptConfigured } = await import("@/lib/infrastructure/weave/promptManager");
    (isWeavePromptConfigured as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { POST } = await import("@/app/api/prompts/sync-to-weave/route");
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("WEAVE_NOT_CONFIGURED");
  });

  it("WANDB_API_KEY設定時は200で同期成功", async () => {
    const { isWeavePromptConfigured } = await import("@/lib/infrastructure/weave/promptManager");
    (isWeavePromptConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { POST } = await import("@/app/api/prompts/sync-to-weave/route");
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toContain("同期");
  });
});
