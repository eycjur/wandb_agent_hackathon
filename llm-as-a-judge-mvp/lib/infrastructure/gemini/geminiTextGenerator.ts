/**
 * 汎用テキスト生成（Judge プロンプト改善案などに使用）
 */
import { GoogleGenAI } from "@google/genai";
import { AppError } from "@/lib/errors";
import { JUDGE_MODEL, MODEL_TIMEOUT_MS, PROMPT_IMPROVE_TIMEOUT_MS } from "@/lib/config/llm";

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "サーバー設定エラーが発生しました。",
      "GEMINI_API_KEY is not set."
    );
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

export async function generateText(
  prompt: string,
  options?: { timeoutMs?: number }
): Promise<string> {
  const ai = getClient();
  const timeoutMs = options?.timeoutMs ?? MODEL_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AppError(
            504,
            "PROVIDER_TIMEOUT",
            "処理がタイムアウトしました。",
            "Model call timed out."
          )
        ),
      timeoutMs
    );
  });

  try {
    const response = await Promise.race([
      ai.models.generateContent({
        model: JUDGE_MODEL,
        contents: prompt,
        config: { temperature: 0.3 }
      }),
      timeoutPromise
    ]);
    if (timer) clearTimeout(timer);

    const text = response.text?.trim();
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
    throw new AppError(
      502,
      "PROVIDER_ERROR",
      "モデル呼び出しに失敗しました。",
      "Model call failed."
    );
  }
}
