/**
 * GEPA による Target（生成）プロンプト最適化
 * lib/promptOptimizer の GEPAOptimizer を使用
 */
import { AppError } from "@/lib/errors";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import { GEPA_MODEL, JUDGE_MODEL, TARGET_MODEL } from "@/lib/config/llm";
import type { EvaluationLogRecord } from "@/lib/infrastructure/evaluationLogStore";
import { calculateTargetGepaMetricBreakdown } from "@/lib/application/promptOptimization/gepaMetrics";
import type { GepaCompileBudget } from "@/lib/application/promptOptimization/gepaRuntimeConfig";
import {
  truncateForGepa,
  GEPA_TARGET_FAST_UI_BUDGET
} from "@/lib/application/promptOptimization/gepaRuntimeConfig";
import {
  logAxOptimizationDone,
  logAxOptimizationStart
} from "@/lib/application/promptOptimization/axOptimizationLogger";
import type { Example, OptimizationTask } from "@/lib/promptOptimizer/types";
import { GEPAOptimizer } from "@/lib/promptOptimizer";
import {
  createGeminiClient,
  runProgram
} from "@/lib/promptOptimizer/runner";

export interface GepaTargetOptimizationResult {
  suggestion: string;
  optimizationLog?: string[];
}

function toExample(
  record: EvaluationLogRecord,
  maxInputChars: number,
  maxOutputChars: number
): Example {
  return {
    inputs: {
      userInput: truncateForGepa(record.userInput ?? "", maxInputChars)
    },
    expectedOutputs: {
      passThreshold: String(record.judgeResult.passThreshold),
      baselineScore: String(record.judgeResult.score),
      domain: record.domain
    }
  };
}

async function runJudge(
  judgeInstruction: string,
  userInput: string,
  generatedOutput: string,
  apiKey?: string
): Promise<{ score: number; reason: string }> {
  const client = createGeminiClient(apiKey);
  const result = await runProgram(
    client,
    JUDGE_MODEL,
    judgeInstruction,
    { userInput, generatedOutput },
    ["score", "reason"]
  );
  return {
    score: Number(result.score ?? 0),
    reason: result.reason ?? ""
  };
}

export async function optimizeTargetPromptWithGEPA(
  failedRecords: EvaluationLogRecord[],
  domain: DomainId,
  budget: GepaCompileBudget = GEPA_TARGET_FAST_UI_BUDGET
): Promise<GepaTargetOptimizationResult> {
  const usableRecords = failedRecords.filter(
    (r) => r.userInput.trim().length > 0 && r.generatedOutput.trim().length > 0
  );
  if (usableRecords.length < 1) {
    return {
      suggestion:
        "GEPA には評価ログが最低1件必要です。生成・評価を実行してから再度お試しください。"
    };
  }

  const promptConfig = await getDomainPromptConfig(domain);
  const judgeInstruction = promptConfig.judgeInstruction;

  // スコアが低い例を優先（改善効果が高い）
  const sortedByLowScore = [...usableRecords].sort(
    (a, b) =>
      (a.judgeResult?.score ?? 1) - (b.judgeResult?.score ?? 1)
  );

  const examples: Example[] = sortedByLowScore
    .slice(0, budget.maxExamples)
    .map((r) => toExample(r, budget.maxInputChars, budget.maxOutputChars));

  const judgeCache = new Map<string, { score: number; formatScore: number }>();

  const metric: OptimizationTask["metric"] = async (prediction, example) => {
    const generatedOutput =
      typeof prediction.generatedOutput === "string"
        ? prediction.generatedOutput.trim()
        : "";
    if (!generatedOutput) return { score: 0, formatScore: 0 };

    const userInput = example.inputs.userInput ?? "";
    const cacheKey = `${userInput}:::${generatedOutput}`;
    const cached = judgeCache.get(cacheKey);
    if (cached != null) return { score: cached.score, formatScore: cached.formatScore * 0.5 };

    try {
      const judgeResult = await runJudge(
        judgeInstruction,
        userInput,
        generatedOutput
      );
      const targetExample = {
        userInput,
        passThreshold: Number(example.expectedOutputs?.passThreshold ?? 0),
        baselineScore: Number(example.expectedOutputs?.baselineScore ?? 0),
        domain: (example.expectedOutputs?.domain ?? domain) as DomainId
      };
      const breakdown = Number.isFinite(judgeResult.score)
        ? calculateTargetGepaMetricBreakdown(
            judgeResult.score,
            generatedOutput,
            targetExample
          )
        : { score: 0, formatScore: 0 };
      judgeCache.set(cacheKey, breakdown);
      return { score: breakdown.score, formatScore: breakdown.formatScore * 0.5 };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[ax-opt][target-gepa:${domain}] metric_error=judge_eval_failed detail=${detail}`
      );
      return { score: 0, formatScore: 0 };
    }
  };

  const task: OptimizationTask = {
    initialPrompt: promptConfig.targetInstruction,
    inputFields: ["userInput"],
    outputFields: ["generatedOutput"],
    examples,
    metric
  };

  const optimizer = new GEPAOptimizer({
    studentModel: TARGET_MODEL,
    teacherModel: GEPA_MODEL,
    numTrials: budget.numTrials,
    minibatchSize: budget.minibatchSize,
    maxIterations: budget.maxIterations,
    earlyStoppingTrials: budget.earlyStoppingTrials,
    timeoutMs:
      budget.compileTimeoutMs != null &&
      budget.compileTimeoutMs < Number.MAX_SAFE_INTEGER
        ? budget.compileTimeoutMs
        : undefined,
    verbose: true,
    onProgress: (p) => {
      const bestStr =
        p.bestScores && Object.keys(p.bestScores).length > 0
          ? Object.entries(p.bestScores)
              .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
              .join(", ")
          : p.bestScore.toFixed(3);
      console.info(
        `[ax-opt][target-gepa:${domain}] step=${p.step} iter=${p.iteration} trial=${p.trial ?? "-"} current=${p.currentScore.toFixed(3)} best=${bestStr} elapsed=${p.elapsedMs}ms`
      );
    }
  });

  logAxOptimizationStart(`target-gepa:${domain}`, examples.length, {
    maxIterations: budget.maxIterations,
    numTrials: budget.numTrials
  });

  let result;
  try {
    result = await optimizer.optimize(task);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      typeof msg === "string" &&
      (msg.includes("signature") || msg.includes("undefined"))
    ) {
      throw new AppError(
        502,
        "PROVIDER_ERROR",
        "GEPA 最適化中にエラーが発生しました。",
        msg
      );
    }
    throw error;
  }

  logAxOptimizationDone(`target-gepa:${domain}`, result.bestScore);

  const suggestion =
    result.optimizedPrompt?.trim() ?? promptConfig.targetInstruction;

  return {
    suggestion,
    optimizationLog: result.log
  };
}
