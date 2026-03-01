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
import {
  buildRubricKeywords,
  calculateJudgeGepaMetric,
  type JudgeGepaMetricExample
} from "@/lib/application/promptOptimization/gepaMetrics";
import {
  type GepaCompileBudget,
  GEPA_JUDGE_FAST_UI_BUDGET,
  truncateForGepa
} from "@/lib/application/promptOptimization/gepaRuntimeConfig";

export interface GepaJudgeOptimizationResult {
  suggestion: string;
  analysisSummary: string;
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
  if (withJudgeResult.length < 3) {
    return {
      suggestion:
        "AxGEPA 最適化には Judge 評価済みの人間評価データが最低3件必要です。自動評価を実行したうえで人間評価を蓄積してから再度お試しください。",
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
  const budget = compileBudget;
  const descriptionParts = [
    promptConfig.judgeInstruction,
    "",
    "score は 0〜5 の整数、reason は日本語の簡潔な説明を返してください。"
  ];

  const judgeProgram = ax(
    "userInput:string, generatedOutput:string -> score:number, reason:string",
    { description: descriptionParts.join("\n") }
  );

  const rubricKeywords = buildRubricKeywords(promptConfig.judgeRubric);

  const examples = withJudgeResult.slice(0, budget.maxExamples).map((r) => ({
    userInput: truncateForGepa(r.userInput, budget.maxInputChars),
    generatedOutput: truncateForGepa(r.generatedOutput, budget.maxOutputChars),
    humanScore: r.humanScore,
    passThreshold: promptConfig.passThreshold,
    humanComment: r.humanComment
      ? truncateForGepa(r.humanComment, budget.maxInputChars)
      : undefined
  }));

  const metricFn = (arg: Readonly<{ prediction: unknown; example: unknown }>): number => {
    const pred = arg.prediction as { score?: unknown; reason?: unknown };
    const ex = arg.example as JudgeGepaMetricExample;
    return calculateJudgeGepaMetric(
      { score: pred?.score, reason: pred?.reason },
      {
        humanScore: Number(ex?.humanScore ?? 0),
        passThreshold: Number(ex?.passThreshold ?? promptConfig.passThreshold),
        humanComment: ex?.humanComment
      },
      rubricKeywords
    );
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
    verbose: false
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AppError(504, "PROVIDER_TIMEOUT", "GEPA 最適化がタイムアウトしました。", "AxGEPA compile timed out.")
        ),
      budget.compileTimeoutMs
    );
  });

  try {
    const result = await Promise.race([
      optimizer.compile(judgeProgram, examples, metricFn, {
        maxMetricCalls: budget.maxMetricCalls,
        maxIterations: budget.maxIterations
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

    const bestScore = (result as { bestScore?: number }).bestScore ?? 0;

    if (!optimizedInstruction) {
      return {
        suggestion: promptConfig.judgeInstruction,
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
