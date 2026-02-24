import { LLMProvider } from "@/lib/domain/llm";
import { GeminiProvider } from "@/lib/infrastructure/gemini/GeminiProvider";

let provider: LLMProvider | null = null;

export function getLLMProvider(): LLMProvider {
  if (provider) {
    return provider;
  }

  provider = new GeminiProvider();
  return provider;
}
