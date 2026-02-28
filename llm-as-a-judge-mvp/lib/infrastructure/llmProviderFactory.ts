import type { LLMProvider, LLMProviderOptions } from "@/lib/domain/llm";
import { AxProvider } from "@/lib/infrastructure/ax/AxProvider";
import { GeminiProvider } from "@/lib/infrastructure/gemini/GeminiProvider";

/**
 * リクエストごとのオプションに応じてプロバイダを返す。
 * llmProvider: ax（既定）| gemini
 * axMethod: few-shot（既定）| ゼロショット | GEPA（ax 選択時のみ有効）
 */
export function getLLMProvider(options?: LLMProviderOptions): LLMProvider {
  const llmProvider = options?.llmProvider ?? "ax";
  const axMethod = options?.axMethod ?? "few-shot";

  if (llmProvider === "gemini") {
    return new GeminiProvider();
  }
  return new AxProvider({ axMethod });
}
