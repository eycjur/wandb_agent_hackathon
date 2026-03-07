/**
 * BootstrapFewShotOptimizer（lib/promptOptimizer）による Judge 本番タスク最適化
 * Ax を使わず独自ライブラリで Few-shot デモを構築
 */
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import { JUDGE_MODEL } from "@/lib/config/llm";
import type { FewShotBudgetOverrides } from "@/lib/contracts/generateEvaluate";
import type { HumanFeedbackRecord } from "@/lib/infrastructure/humanFeedbackStore";
import type { Example, OptimizationTask } from "@/lib/promptOptimizer/types";
import { BootstrapFewShotOptimizer } from "@/lib/promptOptimizer";
import {
  logAxOptimizationDone,
  logAxOptimizationStart
} from "@/lib/application/promptOptimization/axOptimizationLogger";

export interface FewShotJudgeOptimizationResult {
  suggestion: string;
  optimizationLog?: string[];
}

const DEFAULT_MAX_DEMOS = 3;
const DEFAULT_MAX_ROUNDS = 2;
const DEFAULT_DEMO_THRESHOLD = 0.5;

export async function optimizeJudgePromptWithFewShot(
  feedbackRecords: HumanFeedbackRecord[],
  domain: DomainId,
  budget?: FewShotBudgetOverrides
): Promise<FewShotJudgeOptimizationResult> {
  const withJudgeResult = feedbackRecords.filter((r) => r.judgeResult != null);
  if (withJudgeResult.length < 1) {
    return {
      suggestion:
        "Few-shot 最適化には Judge 評価済みの人間評価データが最低1件必要です。自動評価を実行したうえで人間評価を蓄積してから再度お試しください。",
      optimizationLog: undefined
    };
  }

  const promptConfig = await getDomainPromptConfig(domain);

  const examples: Example[] = withJudgeResult.slice(0, 12).map((record) => ({
    inputs: {
      userInput: record.userInput ?? "",
      generatedOutput: record.generatedOutput ?? ""
    },
    expectedOutputs: {
      humanScore: String(record.humanScore),
      passThreshold: String(promptConfig.passThreshold)
    }
  }));

  const metric: OptimizationTask["metric"] = (prediction, example) => {
    const predictedScore = Number(prediction.score);
    const humanScore = Number(example.expectedOutputs?.humanScore ?? 0);

    if (!Number.isFinite(predictedScore)) return 0;
    if (humanScore === 0 && predictedScore !== 0) return 0;

    return Math.max(0, 1 - Math.abs(predictedScore - humanScore) / 5);
  };

  const task: OptimizationTask = {
    initialPrompt: promptConfig.judgeInstruction,
    inputFields: ["userInput", "generatedOutput"],
    outputFields: ["score", "reason"],
    examples,
    metric
  };

  const maxDemos = budget?.maxDemos ?? DEFAULT_MAX_DEMOS;
  const maxRounds = budget?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const demoThreshold = budget?.demoThreshold ?? DEFAULT_DEMO_THRESHOLD;

  const optimizer = new BootstrapFewShotOptimizer({
    studentModel: JUDGE_MODEL,
    teacherModel: JUDGE_MODEL,
    maxDemos,
    maxRounds,
    demoThreshold,
    timeoutMs: budget?.compileTimeoutMs,
    verbose: true,
    onProgress: (p) => {
      const msg = p.message ? ` | ${p.message}` : "";
      console.info(
        `[ax-opt][judge-fewshot:${domain}] step=${p.step} iter=${p.iteration}` +
          ` current=${p.currentScore.toFixed(3)} best=${p.bestScore.toFixed(3)}` +
          ` elapsed=${Math.round(p.elapsedMs / 1000)}s${msg}`
      );
    }
  });

  logAxOptimizationStart(`judge-fewshot:${domain}`, examples.length, {
    maxRounds
  });

  const result = await optimizer.optimize(task);

  logAxOptimizationDone(`judge-fewshot:${domain}`, result.bestScore);

  if (result.demos.length === 0) {
    return {
      suggestion: promptConfig.judgeInstruction,
      optimizationLog: result.log
    };
  }

  return {
    suggestion: result.optimizedPrompt,
    optimizationLog: result.log
  };
}
