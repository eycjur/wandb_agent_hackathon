import { GoogleGenAI, Type } from "@google/genai";
import { AppError } from "@/lib/errors";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import { JUDGE_MODEL, MODEL_TIMEOUT_MS, TARGET_MODEL } from "@/lib/config/llm";
import { JudgeResult, LLMProvider } from "@/lib/domain/llm";

export class GeminiProvider implements LLMProvider {
  name = "gemini";
  models = {
    target: TARGET_MODEL,
    judge: JUDGE_MODEL
  };

  private client: GoogleGenAI | null = null;

  private getClient(): GoogleGenAI {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new AppError(
        500,
        "CONFIG_ERROR",
        "サーバー設定エラーが発生しました。",
        "GEMINI_API_KEY is not set on the server."
      );
    }

    if (!this.client) {
      this.client = new GoogleGenAI({ apiKey });
    }

    return this.client;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race<T>([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new AppError(
                504,
                "PROVIDER_TIMEOUT",
                timeoutMessage,
                "Model call timed out."
              )
            );
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async generateOutput(userInput: string, domain: DomainId): Promise<string> {
    const ai = this.getClient();
    const promptConfig = await getDomainPromptConfig(domain);
    const generationPrompt = [
      promptConfig.targetInstruction,
      "",
      "[職務経歴入力]",
      userInput
    ].join("\n");

    let response: Awaited<ReturnType<typeof ai.models.generateContent>>;
    try {
      response = await this.withTimeout(
        ai.models.generateContent({
          model: TARGET_MODEL,
          contents: generationPrompt,
          config: {
            temperature: 0.7
          }
        }),
        MODEL_TIMEOUT_MS,
        "生成処理がタイムアウトしました。"
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        502,
        "PROVIDER_ERROR",
        "生成モデル呼び出しに失敗しました。",
        "Target model call failed."
      );
    }

    const text = response.text?.trim();

    if (!text) {
      throw new AppError(
        502,
        "PROVIDER_RESPONSE_INVALID",
        "生成モデルから有効な応答を取得できませんでした。",
        "Target model returned an empty response."
      );
    }

    return text;
  }

  async judgeOutput(
    userInput: string,
    generatedOutput: string,
    domain: DomainId
  ): Promise<JudgeResult> {
    const ai = this.getClient();
    const promptConfig = await getDomainPromptConfig(domain);

    const evaluationPrompt = [
      promptConfig.judgeInstruction,
      "",
      "[User Input]",
      userInput,
      "",
      "[Generated Output]",
      generatedOutput
    ].join("\n");

    let response: Awaited<ReturnType<typeof ai.models.generateContent>>;
    try {
      response = await this.withTimeout(
        ai.models.generateContent({
          model: JUDGE_MODEL,
          contents: evaluationPrompt,
          config: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                score: {
                  type: Type.INTEGER,
                  minimum: 0,
                  maximum: 5
                },
                reason: {
                  type: Type.STRING
                }
              },
              required: ["score", "reason"],
              propertyOrdering: ["score", "reason"]
            }
          }
        }),
        MODEL_TIMEOUT_MS,
        "評価処理がタイムアウトしました。"
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        502,
        "PROVIDER_ERROR",
        "評価モデル呼び出しに失敗しました。",
        "Judge model call failed."
      );
    }

    const raw = response.text?.trim();

    if (!raw) {
      throw new AppError(
        502,
        "PROVIDER_RESPONSE_INVALID",
        "評価モデルから有効な応答を取得できませんでした。",
        "Judge model returned an empty response."
      );
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppError(
        502,
        "PROVIDER_RESPONSE_INVALID",
        "評価結果の解析に失敗しました。",
        "Judge output is not valid JSON."
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("score" in parsed) ||
      !("reason" in parsed)
    ) {
      throw new AppError(
        502,
        "PROVIDER_RESPONSE_INVALID",
        "評価結果の形式が不正です。",
        "Judge output does not match required shape."
      );
    }

    const rawScore = (parsed as { score: unknown }).score;
    const rawReason = (parsed as { reason: unknown }).reason;

    if (
      typeof rawScore !== "number" ||
      !Number.isInteger(rawScore) ||
      rawScore < 0 ||
      rawScore > 5
    ) {
      throw new AppError(
        502,
        "PROVIDER_RESPONSE_INVALID",
        "評価スコアの形式が不正です。",
        "Judge score is out of range."
      );
    }

    if (typeof rawReason !== "string" || rawReason.trim().length === 0) {
      throw new AppError(
        502,
        "PROVIDER_RESPONSE_INVALID",
        "評価理由の形式が不正です。",
        "Judge reason is empty."
      );
    }

    return {
      domain: promptConfig.domain,
      rubricVersion: promptConfig.rubricVersion,
      passThreshold: promptConfig.passThreshold,
      score: rawScore,
      reason: rawReason.trim()
    };
  }
}
