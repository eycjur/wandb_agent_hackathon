/**
 * GEPA による Judge プロンプト最適化
 * lib/promptOptimizer の GEPAOptimizer を使用
 */
import { AppError } from "@/lib/errors";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import { GEPA_MODEL, JUDGE_MODEL } from "@/lib/config/llm";
import type { HumanFeedbackRecord } from "@/lib/infrastructure/humanFeedbackStore";
import {
  buildRubricKeywords,
  calculateJudgeGepaMetricBreakdown
} from "@/lib/application/promptOptimization/gepaMetrics";
import type { GepaCompileBudget } from "@/lib/application/promptOptimization/gepaRuntimeConfig";
import {
  truncateForGepa,
  GEPA_JUDGE_FAST_UI_BUDGET
} from "@/lib/application/promptOptimization/gepaRuntimeConfig";
import {
  logAxOptimizationDone,
  logAxOptimizationStart
} from "@/lib/application/promptOptimization/axOptimizationLogger";
import type { Example, OptimizationTask } from "@/lib/promptOptimizer/types";
import { GEPAOptimizer } from "@/lib/promptOptimizer";

export interface GepaJudgeOptimizationResult {
  suggestion: string;
  optimizationLog?: string[];
}

function toExample(
  record: HumanFeedbackRecord,
  passThreshold: number,
  maxInputChars: number,
  maxOutputChars: number
): Example {
  return {
    inputs: {
      userInput: truncateForGepa(record.userInput ?? "", maxInputChars),
      generatedOutput: truncateForGepa(record.generatedOutput ?? "", maxOutputChars)
    },
    expectedOutputs: {
      humanScore: String(record.humanScore),
      passThreshold: String(passThreshold),
      ...(record.humanComment != null && record.humanComment !== ""
        ? { humanComment: record.humanComment }
        : {})
    }
  };
}

export async function optimizeJudgePromptWithGEPA(
  feedbackRecords: HumanFeedbackRecord[],
  domain: DomainId,
  budget: GepaCompileBudget = GEPA_JUDGE_FAST_UI_BUDGET
): Promise<GepaJudgeOptimizationResult> {
  const withJudgeResult = feedbackRecords.filter((r) => r.judgeResult != null);
  if (withJudgeResult.length < 1) {
    return {
      suggestion:
        "GEPA には Judge 評価済みの人間評価データが最低1件必要です。自動評価を実行したうえで人間評価を蓄積してから再度お試しください。"
    };
  }

  const promptConfig = await getDomainPromptConfig(domain);
  const rubricKeywords = buildRubricKeywords(promptConfig.judgeRubric);

  // 人間と Judge の不一致が大きい例を優先（改善効果が高い）
  const sortedByDisagreement = [...withJudgeResult].sort((a, b) => {
    const diffA = Math.abs(
      (a.humanScore ?? 0) - (a.judgeResult?.score ?? a.humanScore ?? 0)
    );
    const diffB = Math.abs(
      (b.humanScore ?? 0) - (b.judgeResult?.score ?? b.humanScore ?? 0)
    );
    return diffB - diffA;
  });

  const selectedRecords = sortedByDisagreement.slice(0, budget.maxExamples);
  const examples: Example[] = selectedRecords.map((r) =>
    toExample(
      r,
      promptConfig.passThreshold,
      budget.maxInputChars,
      budget.maxOutputChars
    )
  );

  // Weave の judgeResult を初期評価のキャッシュとして流用（同一 Judge プロンプトで評価済みの前提）
  const cachedPredictions: Array<Record<string, string> | undefined> =
    selectedRecords.map((r) => {
      const j = r.judgeResult;
      if (!j) return undefined;
      return { score: String(j.score), reason: j.reason ?? "" };
    });

  const metric: OptimizationTask["metric"] = (prediction, example) => {
    const judgeExample = {
      humanScore: Number(example.expectedOutputs?.humanScore ?? 0),
      passThreshold: Number(example.expectedOutputs?.passThreshold ?? 0),
      humanComment: example.expectedOutputs?.humanComment
    };
    const b = calculateJudgeGepaMetricBreakdown(
      { score: prediction.score, reason: prediction.reason },
      judgeExample,
      rubricKeywords
    );
    return {
      scoreAgreement: b.scoreAgreement,
      reasonLength: b.reasonLength * 0.5
    };
  };

  const task: OptimizationTask = {
    initialPrompt: promptConfig.judgeInstruction,
    inputFields: ["userInput", "generatedOutput"],
    outputFields: ["score", "reason"],
    examples,
    metric,
    cachedPredictions
  };

  const optimizer = new GEPAOptimizer({
    studentModel: JUDGE_MODEL,
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
        `[ax-opt][judge-gepa:${domain}] step=${p.step} iter=${p.iteration} trial=${p.trial ?? "-"} current=${p.currentScore.toFixed(3)} best=${bestStr} elapsed=${p.elapsedMs}ms`
      );
    }
  });

  logAxOptimizationStart(`judge-gepa:${domain}`, examples.length, {
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

  logAxOptimizationDone(`judge-gepa:${domain}`, result.bestScore);

  const suggestion = result.optimizedPrompt?.trim() ?? promptConfig.judgeInstruction;

  return {
    suggestion,
    optimizationLog: result.log
  };
}
