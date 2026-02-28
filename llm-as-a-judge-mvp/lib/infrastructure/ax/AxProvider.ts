import { ai, ax, AxAIGoogleGeminiModel } from "@ax-llm/ax";
import { AppError } from "@/lib/errors";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import { JUDGE_MODEL, MODEL_TIMEOUT_MS, TARGET_MODEL } from "@/lib/config/llm";
import { JudgeResult, LLMProvider } from "@/lib/domain/llm";
import type { AxMethodId } from "@/lib/contracts/generateEvaluate";

const TARGET_AX_MODEL = AxAIGoogleGeminiModel.Gemini25Flash;
const JUDGE_AX_MODEL = AxAIGoogleGeminiModel.Gemini25Pro;

type AxProviderConfig = {
  axMethod?: AxMethodId;
};

export class AxProvider implements LLMProvider {
  name = "ax-gemini";
  models = {
    target: TARGET_MODEL,
    judge: JUDGE_MODEL
  };
  private axMethod: AxMethodId;

  constructor(config: AxProviderConfig = {}) {
    this.axMethod = config.axMethod ?? "few-shot";
  }

  private getApiKey(): string {
    const apiKey =
      process.env.GEMINI_API_KEY ?? process.env.GOOGLE_APIKEY ?? "";
    if (!apiKey) {
      throw new AppError(
        500,
        "CONFIG_ERROR",
        "サーバー設定エラーが発生しました。",
        "GEMINI_API_KEY or GOOGLE_APIKEY is not set on the server."
      );
    }
    return apiKey;
  }

  private getTargetLLM() {
    return ai({
      name: "google-gemini",
      apiKey: this.getApiKey(),
      config: {
        model: TARGET_AX_MODEL,
        temperature: 0.7
      },
    });
  }

  private getJudgeLLM() {
    return ai({
      name: "google-gemini",
      apiKey: this.getApiKey(),
      config: {
        model: JUDGE_AX_MODEL,
        temperature: 0
      }
    });
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
          timer = setTimeout(
            () =>
              reject(
                new AppError(504, "PROVIDER_TIMEOUT", timeoutMessage, "Model call timed out.")
              ),
            timeoutMs
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async generateOutput(userInput: string, domain: DomainId): Promise<string> {
    const promptConfig = await getDomainPromptConfig(domain);
    const descriptionParts = [
      promptConfig.targetInstruction,
      "",
      "以下が [職務経歴入力] です。"
    ];
    if ((this.axMethod === "few-shot" || this.axMethod === "gepa") && promptConfig.samples?.length) {
      descriptionParts.push(
        "",
        "参考となる入力例:",
        ...promptConfig.samples.slice(0, 2).map((s) => `【${s.title}】\n${s.input}`)
      );
    }
    const generator = ax("userInput:string -> output:string", {
      description: descriptionParts.join("\n")
    });

    try {
      const result = await this.withTimeout(
        generator.forward(this.getTargetLLM(), { userInput }, { stream: false }),
        MODEL_TIMEOUT_MS,
        "生成処理がタイムアウトしました。"
      );
      const text = result.output?.trim();
      if (!text) {
        throw new AppError(
          502,
          "PROVIDER_RESPONSE_INVALID",
          "生成モデルから有効な応答を取得できませんでした。",
          "Target model returned an empty response."
        );
      }
      return text;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && error.message.includes("timeout")) {
        throw new AppError(
          504,
          "PROVIDER_TIMEOUT",
          "生成処理がタイムアウトしました。",
          "Model call timed out."
        );
      }
      throw new AppError(
        502,
        "PROVIDER_ERROR",
        "生成モデル呼び出しに失敗しました。",
        "Target model call failed."
      );
    }
  }

  async judgeOutput(
    userInput: string,
    generatedOutput: string,
    domain: DomainId
  ): Promise<JudgeResult> {
    const promptConfig = await getDomainPromptConfig(domain);
    const descriptionParts = [
      promptConfig.judgeInstruction,
      "",
      "score は 0〜5 の整数、reason は日本語の簡潔な説明を返してください。"
    ];
    if ((this.axMethod === "few-shot" || this.axMethod === "gepa") && promptConfig.samples?.length) {
      descriptionParts.push(
        "",
        "参考となる入力例（評価対象の形式理解用）:",
        ...promptConfig.samples.slice(0, 2).map((s) => `【${s.title}】入力: ${s.input.slice(0, 200)}...`)
      );
    }
    const judge = ax(
      "userInput:string, generatedOutput:string -> score:number, reason:string",
      { description: descriptionParts.join("\n") }
    );

    try {
      const result = await this.withTimeout(
        judge.forward(
          this.getJudgeLLM(),
          { userInput, generatedOutput },
          { stream: false }
        ),
        MODEL_TIMEOUT_MS,
        "評価処理がタイムアウトしました。"
      );

      const rawScore = result.score;
      const rawReason = result.reason;

      if (
        rawScore === undefined ||
        rawScore === null ||
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

      if (
        typeof rawReason !== "string" ||
        (rawReason as string).trim().length === 0
      ) {
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
        reason: (rawReason as string).trim()
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && error.message.includes("timeout")) {
        throw new AppError(
          504,
          "PROVIDER_TIMEOUT",
          "評価処理がタイムアウトしました。",
          "Model call timed out."
        );
      }
      throw new AppError(
        502,
        "PROVIDER_ERROR",
        "評価モデル呼び出しに失敗しました。",
        "Judge model call failed."
      );
    }
  }
}
