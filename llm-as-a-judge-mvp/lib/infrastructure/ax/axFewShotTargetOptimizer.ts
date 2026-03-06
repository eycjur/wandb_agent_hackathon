/**
 * BootstrapFewShotOptimizer（lib/promptOptimizer）による生成本番タスク最適化
 * Ax を使わず独自ライブラリで Few-shot デモを構築
 */
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import { JUDGE_MODEL, TARGET_MODEL } from "@/lib/config/llm";
import type { FewShotBudgetOverrides } from "@/lib/contracts/generateEvaluate";
import type { EvaluationLogRecord } from "@/lib/infrastructure/evaluationLogStore";
import type { Example, OptimizationTask } from "@/lib/promptOptimizer/types";
import { BootstrapFewShotOptimizer } from "@/lib/promptOptimizer";
import {
  createGeminiClient,
  runProgram
} from "@/lib/promptOptimizer/runner";
import {
  logAxOptimizationDone,
  logAxOptimizationStart
} from "@/lib/application/promptOptimization/axOptimizationLogger";

export interface FewShotTargetOptimizationResult {
  suggestion: string;
  optimizationLog?: string[];
}

const DEFAULT_MAX_DEMOS = 3;
const DEFAULT_MAX_ROUNDS = 2;
const DEFAULT_DEMO_THRESHOLD = 0.4;

export async function optimizeTargetPromptWithFewShot(
  records: EvaluationLogRecord[],
  domain: DomainId,
  budget?: FewShotBudgetOverrides
): Promise<FewShotTargetOptimizationResult> {
  const usableRecords = records.filter(
    (r) => r.userInput.trim().length > 0 && r.generatedOutput.trim().length > 0
  );
  if (usableRecords.length < 1) {
    return {
      suggestion:
        "Few-shot 最適化には評価ログが最低1件必要です。生成・評価を実行してから再度お試しください。",
      optimizationLog: undefined
    };
  }

  const promptConfig = await getDomainPromptConfig(domain);
  const client = createGeminiClient();
  const judgeCache = new Map<string, number>();

  const examples: Example[] = usableRecords.slice(0, 12).map((record) => ({
    inputs: {
      userInput: record.userInput ?? ""
    },
    expectedOutputs: {
      passThreshold: String(record.judgeResult.passThreshold),
      domain: record.domain
    }
  }));

  const metric: OptimizationTask["metric"] = async (prediction, example) => {
    const generatedOutput =
      typeof prediction.generatedOutput === "string"
        ? prediction.generatedOutput.trim()
        : "";
    if (!generatedOutput) return 0;

    const userInput = example.inputs.userInput ?? "";
    const cacheKey = `${userInput}:::${generatedOutput}`;
    const cached = judgeCache.get(cacheKey);
    if (cached != null) return cached;

    try {
      const judgeResult = await runProgram(
        client,
        JUDGE_MODEL,
        promptConfig.judgeInstruction,
        { userInput, generatedOutput },
        ["score", "reason"]
      );
      const judgeScore = Number(judgeResult.score);
      const metricScore = Number.isFinite(judgeScore)
        ? Math.max(0, Math.min(1, judgeScore / 5))
        : 0;
      judgeCache.set(cacheKey, metricScore);
      return metricScore;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[fewshot-opt][target-fewshot:${domain}] metric_error=judge_eval_failed detail=${detail}`
      );
      return 0;
    }
  };

  const task: OptimizationTask = {
    initialPrompt: promptConfig.targetInstruction,
    inputFields: ["userInput"],
    outputFields: ["generatedOutput"],
    examples,
    metric
  };

  const maxDemos = budget?.maxDemos ?? DEFAULT_MAX_DEMOS;
  const maxRounds = budget?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const demoThreshold = budget?.demoThreshold ?? DEFAULT_DEMO_THRESHOLD;

  const optimizer = new BootstrapFewShotOptimizer({
    studentModel: TARGET_MODEL,
    teacherModel: TARGET_MODEL,
    maxDemos,
    maxRounds,
    demoThreshold,
    timeoutMs: budget?.compileTimeoutMs,
    verbose: true
  });

  logAxOptimizationStart(`target-fewshot:${domain}`, examples.length, {
    maxRounds
  });

  const result = await optimizer.optimize(task);

  logAxOptimizationDone(`target-fewshot:${domain}`, result.bestScore);

  return {
    suggestion: result.optimizedPrompt,
    optimizationLog: result.log
  };
}
