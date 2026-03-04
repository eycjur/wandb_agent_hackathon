/**
 * AxGEPA による生成プロンプト最適化
 * 不合格ケースの userInput を用い、Judge スコアが向上するようプロンプトを最適化する
 */
import { ai, ax, AxAIGoogleGeminiModel, AxGEPA } from "@ax-llm/ax";
import { AppError } from "@/lib/errors";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import { GEPA_MODEL, JUDGE_MODEL, TARGET_MODEL } from "@/lib/config/llm";
import type { EvaluationLogRecord } from "@/lib/infrastructure/evaluationLogStore";
import {
  calculateTargetGepaMetricBreakdown,
  type TargetGepaMetricExample
} from "@/lib/application/promptOptimization/gepaMetrics";
import {
  type GepaCompileBudget,
  GEPA_TARGET_FAST_UI_BUDGET,
  truncateForGepa
} from "@/lib/application/promptOptimization/gepaRuntimeConfig";
import {
  createAxOptimizerEventLogger,
  createAxProgressLogger,
  createAxMultiMetricLogger,
  logAxOptimizationDone,
  logAxOptimizationStart
} from "@/lib/application/promptOptimization/axOptimizationLogger";

export interface GepaTargetOptimizationResult {
  suggestion: string;
  analysisSummary: string;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("metric timeout")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 不合格・低スコアの評価データを用いて AxGEPA で生成プロンプトを最適化する
 * メトリクス: 生成出力を Judge で評価し、スコアを最大化
 */
export async function optimizeTargetPromptWithGEPA(
  failedRecords: EvaluationLogRecord[],
  domain: DomainId,
  compileBudget: GepaCompileBudget = GEPA_TARGET_FAST_UI_BUDGET
): Promise<GepaTargetOptimizationResult> {
  if (failedRecords.length < 1) {
    return {
      suggestion:
        "AxGEPA 最適化には不合格・低スコアの評価データが最低1件必要です。生成・評価を実行してから再度お試しください。",
      analysisSummary: "データ不足（1件未満）"
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
  const budget = compileBudget;
  const generatorProgram = ax("userInput:string -> generatedOutput:string", {
    description: promptConfig.targetInstruction
  });

  const judgeProgram = ax(
    "userInput:string, generatedOutput:string -> score:number, reason:string",
    { description: promptConfig.judgeInstruction }
  );

  const examples = failedRecords.slice(0, budget.maxExamples).map((r) => ({
    userInput: truncateForGepa(r.userInput, budget.maxInputChars),
    passThreshold: r.judgeResult.passThreshold,
    baselineScore: r.judgeResult.score,
    domain
  }));
  const logMetric = createAxMultiMetricLogger(`target-gepa:${domain}`);
  const judgeFeedbackCache = new Map<string, { score: number; reason: string }>();

  const targetAI = ai({
    name: "google-gemini",
    apiKey,
    config: { model: TARGET_MODEL as AxAIGoogleGeminiModel, temperature: 0.7 }
  });

  const judgeAI = ai({
    name: "google-gemini",
    apiKey,
    config: { model: GEPA_MODEL as AxAIGoogleGeminiModel, temperature: 0 }
  });
  const teacherAI = ai({
    name: "google-gemini",
    apiKey,
    config: { model: JUDGE_MODEL as AxAIGoogleGeminiModel, temperature: 0 }
  });

  const metricFn = async (
    arg: Readonly<{ prediction: unknown; example: unknown }>
  ): Promise<Record<string, number>> => {
    const rawOutput = (arg.prediction as { generatedOutput?: string })?.generatedOutput?.trim();
    const output = rawOutput
      ? truncateForGepa(rawOutput, budget.maxOutputChars)
      : rawOutput;
    if (!output) {
      const zero = {
        absoluteQuality: 0,
        improvementDelta: 0,
        passReached: 0,
        formatScore: 0
      };
      logMetric(zero);
      return zero;
    }

    const ex = arg.example as TargetGepaMetricExample;
    const userInput = ex?.userInput ?? "";

    try {
      const metricTimeoutMs = budget.metricCallTimeoutMs ?? 7000;
      const judgeResult = await withTimeout(
        judgeProgram.forward(
          judgeAI,
          { userInput, generatedOutput: output },
          { stream: false }
        ),
        metricTimeoutMs
      );
      judgeFeedbackCache.set(`${userInput}:::${output}`, {
        score: Number(judgeResult.score ?? 0),
        reason: typeof judgeResult.reason === "string" ? judgeResult.reason : ""
      });

      const breakdown = calculateTargetGepaMetricBreakdown(
        judgeResult.score,
        output,
        {
        userInput,
        passThreshold: Number(ex?.passThreshold ?? 4),
        baselineScore: Number(ex?.baselineScore ?? 0),
        domain: ex?.domain ?? domain
        }
      );
      logMetric(breakdown);
      return breakdown;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        502,
        "PROVIDER_ERROR",
        "GEPA メトリクス評価に失敗しました。",
        error instanceof Error ? error.message : "Target GEPA metric evaluation failed."
      );
    }
  };

  const optimizer = new AxGEPA({
    studentAI: targetAI,
    teacherAI,
    numTrials: budget.numTrials,
    minibatch: true,
    minibatchSize: budget.minibatchSize,
    earlyStoppingTrials: budget.earlyStoppingTrials,
    onProgress: createAxProgressLogger(`target-gepa:${domain}`),
    optimizerLogger: createAxOptimizerEventLogger(`target-gepa:${domain}`),
    debugOptimizer: true,
    verbose: false
  });

  try {
    logAxOptimizationStart(`target-gepa:${domain}`, examples.length);
    const result = await optimizer.compile(
      generatorProgram,
      examples,
      metricFn as unknown as Parameters<typeof optimizer.compile>[2],
      {
        feedbackExamples: examples,
        feedbackFn: ({ prediction, example }) => {
          const pred = prediction as { generatedOutput?: unknown };
          const ex = example as TargetGepaMetricExample;
          const output =
            typeof pred?.generatedOutput === "string"
              ? pred.generatedOutput.trim()
              : "";
          if (!output) {
            return "generatedOutput が空です。入力に対して具体的な出力を返してください。";
          }
          const userInput = ex?.userInput ?? "";
          const judgeFeedback = judgeFeedbackCache.get(`${userInput}:::${output}`);
          if (!judgeFeedback) {
            return "Judge評価のFBが未取得です。スコア・理由を改善案に反映してください。";
          }
          const passThreshold = Number(ex?.passThreshold ?? 4);
          if (judgeFeedback.score < passThreshold) {
            return `Judge評価: ${judgeFeedback.score}/${passThreshold}。理由: ${judgeFeedback.reason || "理由なし"}。この不合格理由を解消するよう改善してください。`;
          }
          return `Judge評価は合格圏です（${judgeFeedback.score}/${passThreshold}）。理由の一貫性を維持しつつ baseline(${Number(ex?.baselineScore ?? 0)})超えを狙ってください。`;
        },
        maxMetricCalls: budget.maxMetricCalls,
        maxIterations: budget.maxIterations
      }
    );

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
    logAxOptimizationDone(`target-gepa:${domain}`, bestScore);

    if (!optimizedInstruction) {
      throw new AppError(
        502,
        "PROVIDER_RESPONSE_INVALID",
        "GEPA 最適化結果の取得に失敗しました。",
        "optimized instruction is missing in GEPA result."
      );
    }

    const suggestion = String(optimizedInstruction).trim();
    if (!suggestion) {
      throw new AppError(
        502,
        "PROVIDER_RESPONSE_INVALID",
        "GEPA 最適化結果が空です。",
        "optimized instruction is empty after trim."
      );
    }

    return {
      suggestion,
      analysisSummary: `AxGEPA 最適化完了。ベストスコア: ${bestScore.toFixed(2)}、評価件数: ${examples.length}`
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      502,
      "PROVIDER_ERROR",
      "GEPA 最適化に失敗しました。",
      error instanceof Error ? error.message : "AxGEPA compile failed."
    );
  }
}
