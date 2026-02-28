/**
 * プロンプト改善案生成用の汎用テキスト生成
 * ax / Gemini の選択に応じて LLM を切り替える
 */
import { ai, ax, AxAIGoogleGeminiModel } from "@ax-llm/ax";
import { AppError } from "@/lib/errors";
import { JUDGE_MODEL, PROMPT_IMPROVE_TIMEOUT_MS } from "@/lib/config/llm";
import { generateText } from "@/lib/infrastructure/gemini/geminiTextGenerator";
import type { AxMethodId, LLMProviderId } from "@/lib/contracts/generateEvaluate";

export type PromptImproveGeneratorOptions = {
  llmProvider?: LLMProviderId;
  axMethod?: AxMethodId;
};

/**
 * 任意のプロンプトを LLM に送り、テキスト応答を返す。
 * プロンプト改善案の生成に使用。
 */
export async function generateTextForPromptImprovement(
  prompt: string,
  options: PromptImproveGeneratorOptions = {}
): Promise<string> {
  const llmProvider = options.llmProvider ?? "ax";

  if (llmProvider === "gemini") {
    return generateText(prompt, { timeoutMs: PROMPT_IMPROVE_TIMEOUT_MS });
  }

  // ax の場合: ax() のシグネチャでプロンプトを送信
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_APIKEY ?? "";
  if (!apiKey) {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "サーバー設定エラーが発生しました。",
      "GEMINI_API_KEY or GOOGLE_APIKEY is not set."
    );
  }

  const llm = ai({
    name: "google-gemini",
    apiKey,
    config: {
      model: JUDGE_MODEL as AxAIGoogleGeminiModel,
      temperature: 0.3
    }
  });

  const generator = ax("prompt:string -> responseText:string", {
    description: "任意のプロンプトに応答し、テキストを返す。"
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AppError(504, "PROVIDER_TIMEOUT", "処理がタイムアウトしました。", "Model call timed out.")
        ),
      PROMPT_IMPROVE_TIMEOUT_MS
    );
  });

  try {
    const result = await Promise.race([
      generator.forward(llm, { prompt }, { stream: false }),
      timeoutPromise
    ]);
    if (timer) clearTimeout(timer);

    const text = result.responseText?.trim();
    if (!text) {
      throw new AppError(
        502,
        "PROVIDER_RESPONSE_INVALID",
        "モデルから有効な応答を取得できませんでした。",
        "Empty response."
      );
    }
    return text;
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (error instanceof AppError) throw error;
    throw new AppError(502, "PROVIDER_ERROR", "モデル呼び出しに失敗しました。", "Model call failed.");
  }
}
