import { describe, expect, it, vi } from "vitest";
import { GenerateAndEvaluateUseCase } from "@/lib/application/generateAndEvaluateUseCase";
import { LLMProvider } from "@/lib/domain/llm";

function createProvider(score: number, passThreshold: number): LLMProvider {
  return {
    name: "mock",
    models: {
      target: "target",
      judge: "judge"
    },
    generateOutput: vi.fn(async () => "generated summary"),
    judgeOutput: vi.fn(async () => ({
      domain: "resume_summary",
      rubricVersion: 1,
      passThreshold,
      score,
      reason: "ok"
    }))
  };
}

describe("GenerateAndEvaluateUseCase", () => {
  it("scoreが閾値以上ならpass=trueを返す", async () => {
    const provider = createProvider(4, 4);
    const useCase = new GenerateAndEvaluateUseCase(provider);

    const result = await useCase.execute("resume text");

    expect(result.pass).toBe(true);
    expect(result.domain).toBe("resume_summary");
    expect(result.rubricVersion).toBe(1);
    expect(result.passThreshold).toBe(4);
    expect(result.score).toBe(4);
    expect(result.generatedOutput).toBe("generated summary");
  });

  it("scoreが閾値未満ならpass=falseを返す", async () => {
    const provider = createProvider(2, 4);
    const useCase = new GenerateAndEvaluateUseCase(provider);

    const result = await useCase.execute("resume text");

    expect(result.pass).toBe(false);
    expect(result.score).toBe(2);
    expect(result.passThreshold).toBe(4);
  });
});
