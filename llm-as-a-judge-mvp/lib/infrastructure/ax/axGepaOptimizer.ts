/**
 * AxGEPA による Judge プロンプト最適化
 * 人間評価データを教師として、Judge の評価が人間の感覚に近づくようプロンプトを最適化する
 */
import { ai, ax, AxAIGoogleGeminiModel, AxGEPA } from "@ax-llm/ax";
import { AppError } from "@/lib/errors";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import { GEPA_MODEL } from "@/lib/config/llm";
import type { HumanFeedbackRecord } from "@/lib/infrastructure/humanFeedbackStore";
import type { JudgeGepaMetricExample } from "@/lib/application/promptOptimization/gepaMetrics";
import {
  type GepaCompileBudget,
  GEPA_JUDGE_FAST_UI_BUDGET,
  truncateForGepa
} from "@/lib/application/promptOptimization/gepaRuntimeConfig";
import {
  createAxOptimizerEventLogger,
  createAxProgressLogger,
  createAxMultiMetricLogger,
  logAxOptimizationDone,
  logAxOptimizationStart
} from "@/lib/application/promptOptimization/axOptimizationLogger";

export interface GepaJudgeOptimizationResult {
  suggestion: string;
  analysisSummary: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function toScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.round(n), 0), 5);
}

function reasonLengthScoreHalf(reason: unknown): number {
  const text = typeof reason === "string" ? reason.trim() : "";
  const len = text.length;
  if (len === 0) return 0;
  const base = len < 20 ? clamp01(len / 20) : len <= 220 ? 1 : clamp01(1 - (len - 220) / 280);
  // 指定: 理由文長さは 1/2 スケール
  return clamp01(base / 2);
}

/**
 * 人間評価データを用いて AxGEPA で Judge プロンプトを最適化する
 */
export async function optimizeJudgePromptWithGEPA(
  feedbackRecords: HumanFeedbackRecord[],
  domain: DomainId,
  compileBudget: GepaCompileBudget = GEPA_JUDGE_FAST_UI_BUDGET
): Promise<GepaJudgeOptimizationResult> {
  const withJudgeResult = feedbackRecords.filter((r) => r.judgeResult != null);
  if (withJudgeResult.length < 1) {
    return {
      suggestion:
        "AxGEPA 最適化には Judge 評価済みの人間評価データが最低1件必要です。自動評価を実行したうえで人間評価を蓄積してから再度お試しください。",
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
  const judgeProgram = ax(
    "userInput:string, generatedOutput:string -> score:number, reason:string",
    { description: promptConfig.judgeInstruction }
  );

  const examples = withJudgeResult.slice(0, budget.maxExamples).map((r) => ({
    userInput: truncateForGepa(r.userInput, budget.maxInputChars),
    generatedOutput: truncateForGepa(r.generatedOutput, budget.maxOutputChars),
    humanScore: r.humanScore,
    passThreshold: promptConfig.passThreshold,
    humanComment: r.humanComment
      ? truncateForGepa(r.humanComment, budget.maxInputChars)
      : undefined
  }));
  const logMetric = createAxMultiMetricLogger(`judge-gepa:${domain}`);

  const metricFn = (arg: Readonly<{ prediction: unknown; example: unknown }>): Record<string, number> => {
    const pred = arg.prediction as { score?: unknown; reason?: unknown };
    const ex = arg.example as JudgeGepaMetricExample;
    const predictedScore = toScore(pred?.score);
    const humanScore = toScore(ex?.humanScore ?? 0);
    const scoreAgreement = clamp01(1 - Math.abs(predictedScore - humanScore) / 5);
    const breakdown = {
      scoreAgreement,
      reasonLengthHalf: reasonLengthScoreHalf(pred?.reason)
    };
    logMetric(breakdown);
    return breakdown;
  };

  const studentAI = ai({
    name: "google-gemini",
    apiKey,
    config: {
      model: GEPA_MODEL as AxAIGoogleGeminiModel,
      temperature: 0
    }
  });
  const optimizer = new AxGEPA({
    studentAI,
    numTrials: budget.numTrials,
    minibatch: true,
    minibatchSize: budget.minibatchSize,
    earlyStoppingTrials: budget.earlyStoppingTrials,
    onProgress: createAxProgressLogger(`judge-gepa:${domain}`),
    optimizerLogger: createAxOptimizerEventLogger(`judge-gepa:${domain}`),
    debugOptimizer: true,
    verbose: false
  });

  try {
    logAxOptimizationStart(`judge-gepa:${domain}`, examples.length);
    const result = await optimizer.compile(
      judgeProgram,
      examples,
      metricFn as unknown as Parameters<typeof optimizer.compile>[2],
      {
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

    const bestScore = (result as { bestScore?: number }).bestScore ?? 0;
    logAxOptimizationDone(`judge-gepa:${domain}`, bestScore);

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
