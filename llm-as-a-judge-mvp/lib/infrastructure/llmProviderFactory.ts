import type { LLMProvider, LLMProviderOptions } from "@/lib/domain/llm";
import { AxProvider } from "@/lib/infrastructure/ax/AxProvider";
import { GeminiProvider } from "@/lib/infrastructure/gemini/GeminiProvider";

/**
 * リクエストごとのオプションに応じてプロバイダを返す。
 * llmProvider: ax（既定）| gemini
 * improvementMethod はプロンプト改善API向けの指定値（生成/評価APIの AxProvider では利用しない）
 */
export function getLLMProvider(options?: LLMProviderOptions): LLMProvider {
  const llmProvider = options?.llmProvider ?? "ax";

  if (llmProvider === "gemini") {
    return new GeminiProvider();
  }
  return new AxProvider();
}
