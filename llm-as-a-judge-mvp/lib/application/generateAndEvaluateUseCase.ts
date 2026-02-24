import { GenerateEvaluateResult, LLMProvider } from "@/lib/domain/llm";

export class GenerateAndEvaluateUseCase {
  constructor(private readonly provider: LLMProvider) { }

  async execute(userInput: string): Promise<GenerateEvaluateResult> {
    const generatedOutput = await this.provider.generateOutput(userInput);
    const { score, reason, rubricVersion, passThreshold, domain } = await this.provider.judgeOutput(
      userInput,
      generatedOutput
    );

    return {
      domain,
      rubricVersion,
      passThreshold,
      pass: score >= passThreshold,
      generatedOutput,
      score,
      reason
    };
  }
}
