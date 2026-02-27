import type { DomainId } from "@/lib/config/domainPromptLoader";
import { GenerateEvaluateResult, LLMProvider } from "@/lib/domain/llm";

export class GenerateAndEvaluateUseCase {
  constructor(private readonly provider: LLMProvider) {}

  async execute(
    userInput: string,
    domain: DomainId = "resume_summary"
  ): Promise<GenerateEvaluateResult> {
    const generatedOutput = await this.provider.generateOutput(userInput, domain);
    const { score, reason, rubricVersion, passThreshold, domain: resultDomain } =
      await this.provider.judgeOutput(userInput, generatedOutput, domain);

    return {
      domain: resultDomain,
      rubricVersion,
      passThreshold,
      pass: score >= passThreshold,
      generatedOutput,
      score,
      reason
    };
  }
}
