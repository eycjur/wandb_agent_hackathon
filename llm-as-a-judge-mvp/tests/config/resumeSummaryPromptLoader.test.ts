import { describe, expect, it } from "vitest";
import { getResumeSummaryPromptConfig } from "@/lib/config/resumeSummaryPromptLoader";

describe("resumeSummaryPromptLoader", () => {
  it("ドメイン設定とサンプル入力を読み込める", async () => {
    const config = await getResumeSummaryPromptConfig();

    expect(config.domain).toBe("resume_summary");
    expect(config.rubricVersion).toBeGreaterThan(0);
    expect(config.passThreshold).toBeGreaterThanOrEqual(0);
    expect(config.passThreshold).toBeLessThanOrEqual(5);
    expect(config.targetInstruction.length).toBeGreaterThan(0);
    expect(config.judgeInstruction.length).toBeGreaterThan(0);
    expect(config.judgeRubric.length).toBeGreaterThan(0);
    expect(config.samples.length).toBeGreaterThanOrEqual(2);
    expect(config.samples[0].title.length).toBeGreaterThan(0);
    expect(config.samples[0].input.length).toBeGreaterThan(0);
  });
});
