/**
 * AxGEPA による生成プロンプト最適化
 * 不合格ケースの userInput を用い、Judge スコアが向上するようプロンプトを最適化する
 */
import { ai, ax, AxAIGoogleGeminiModel, AxGEPA } from "@ax-llm/ax";
import { AppError } from "@/lib/errors";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import { JUDGE_MODEL, MODEL_TIMEOUT_MS, TARGET_MODEL } from "@/lib/config/llm";
import type { EvaluationLogRecord } from "@/lib/infrastructure/evaluationLogStore";
import {
  calculateTargetGepaMetric,
  type TargetGepaMetricExample
} from "@/lib/infrastructure/ax/gepaMetrics";

export interface GepaTargetOptimizationResult {
  suggestion: string;
  analysisSummary: string;
}

/**
 * 不合格・低スコアの評価データを用いて AxGEPA で生成プロンプトを最適化する
 * メトリクス: 生成出力を Judge で評価し、スコアを最大化
 */
export async function optimizeTargetPromptWithGEPA(
  failedRecords: EvaluationLogRecord[],
  domain: DomainId
): Promise<GepaTargetOptimizationResult> {
  if (failedRecords.length < 3) {
    return {
      suggestion:
        "AxGEPA 最適化には不合格・低スコアの評価データが最低3件必要です。生成・評価を実行してから再度お試しください。",
      analysisSummary: "データ不足（3件未満）"
    };
  }

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_APIKEY ?? "";
  if (!apiKey) {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "サーバー設定エラーが発生しました。",
      "GEMINI_API_KEY or GOOGLE_APIKEY is not set."
    );
  }

  const promptConfig = await getDomainPromptConfig(domain);
  const targetDescription = [
    promptConfig.targetInstruction,
    "",
    "以下が [職務経歴入力] です。"
  ].join("\n");

  const generatorProgram = ax("userInput:string -> generatedOutput:string", {
    description: targetDescription
  });

  const judgeDescription = [
    promptConfig.judgeInstruction,
    "",
    "score は 0〜5 の整数、reason は日本語の簡潔な説明を返してください。"
  ].join("\n");

  const judgeProgram = ax(
    "userInput:string, generatedOutput:string -> score:number, reason:string",
    { description: judgeDescription }
  );

  const examples = failedRecords.slice(0, 12).map((r) => ({
    userInput: r.userInput,
    passThreshold: r.judgeResult.passThreshold,
    baselineScore: r.judgeResult.score,
    domain
  }));

  const targetAI = ai({
    name: "google-gemini",
    apiKey,
    config: { model: TARGET_MODEL as AxAIGoogleGeminiModel, temperature: 0.7 }
  });

  const judgeAI = ai({
    name: "google-gemini",
    apiKey,
    config: { model: JUDGE_MODEL as AxAIGoogleGeminiModel, temperature: 0 }
  });

  const metricFn = async (arg: Readonly<{ prediction: unknown; example: unknown }>): Promise<number> => {
    const output = (arg.prediction as { generatedOutput?: string })?.generatedOutput?.trim();
    if (!output) return 0;

    const ex = arg.example as TargetGepaMetricExample;
    const userInput = ex?.userInput ?? "";

    try {
      const judgeResult = await judgeProgram.forward(
        judgeAI,
        { userInput, generatedOutput: output },
        { stream: false }
      );
      return calculateTargetGepaMetric(judgeResult.score, output, {
        userInput,
        passThreshold: Number(ex?.passThreshold ?? 4),
        baselineScore: Number(ex?.baselineScore ?? 0),
        domain: ex?.domain ?? domain
      });
    } catch {
      return 0;
    }
  };

  const optimizer = new AxGEPA({
    studentAI: targetAI,
    numTrials: 6,
    minibatch: true,
    minibatchSize: 3,
    earlyStoppingTrials: 2,
    verbose: false
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AppError(504, "PROVIDER_TIMEOUT", "GEPA 最適化がタイムアウトしました。", "AxGEPA compile timed out.")
        ),
      MODEL_TIMEOUT_MS * 4
    );
  });

  try {
    const result = await Promise.race([
      optimizer.compile(generatorProgram, examples, metricFn, {
        maxMetricCalls: 60,
        maxIterations: 4
      }),
      timeoutPromise
    ]);
    if (timer) clearTimeout(timer);

    const r = result as unknown as {
      optimizedProgram?: { instruction?: string };
      paretoFront?: ReadonlyArray<{ configuration?: Record<string, unknown> }>;
      bestConfiguration?: Record<string, unknown>;
      stats?: { bestConfiguration?: Record<string, unknown> };
    };
    const config =
      r.optimizedProgram ?? r.paretoFront?.[0]?.configuration ?? r.bestConfiguration ?? r.stats?.bestConfiguration;
    const optimizedInstruction =
      typeof r.optimizedProgram?.instruction === "string"
        ? r.optimizedProgram.instruction
        : typeof config?.instruction === "string"
          ? config.instruction
          : undefined;

    const bestScore = (result as unknown as { bestScore?: number }).bestScore ?? 0;

    if (!optimizedInstruction) {
      return {
        suggestion: promptConfig.targetInstruction,
        analysisSummary: `GEPA 最適化完了（スコア: ${bestScore.toFixed(2)}）。最適化された instruction の抽出に失敗したため、元のプロンプトを返しています。`
      };
    }

    return {
      suggestion: String(optimizedInstruction).trim(),
      analysisSummary: `AxGEPA 最適化完了。ベストスコア: ${bestScore.toFixed(2)}、評価件数: ${examples.length}`
    };
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (error instanceof AppError) throw error;
    throw new AppError(
      502,
      "PROVIDER_ERROR",
      "GEPA 最適化に失敗しました。",
      error instanceof Error ? error.message : "AxGEPA compile failed."
    );
  }
}
