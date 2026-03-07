/**
 * Prompt Optimization Library
 *
 * 汎用プロンプト最適化ライブラリ。3つの最適化手法を提供する:
 *
 * - MetaPromptOptimizer:  LLMによるイテレーティブな改善 (OPRO ベース)
 * - BootstrapFewShotOptimizer: DSPy流 Bootstrap Few-Shot
 * - GEPAOptimizer:        反省的プロンプト進化 (GEPA, ICLR 2026)
 *
 * @example
 * ```typescript
 * // 方法 1: クラスを直接使用
 * import { GEPAOptimizer } from "@/lib/promptOptimizer";
 *
 * const optimizer = new GEPAOptimizer({
 *   studentModel: "gemini-2.5-flash-lite",
 *   teacherModel: "gemini-2.5-flash",
 *   timeoutMs: 60_000,
 *   verbose: true,
 *   numTrials: 3,
 *   maxIterations: 5,
 * });
 *
 * const result = await optimizer.optimize({
 *   initialPrompt: "感情を分析してください。",
 *   inputFields: ["review"],
 *   outputFields: ["sentiment"],
 *   examples: [
 *     { inputs: { review: "最高でした！" }, expectedOutputs: { sentiment: "positive" } },
 *   ],
 *   metric: (pred, ex) => pred.sentiment === ex.expectedOutputs?.sentiment ? 1 : 0,
 * });
 *
 * console.log(result.optimizedPrompt);
 * console.log(`スコア: ${result.bestScore.toFixed(3)} (初期: ${result.initialScore.toFixed(3)})`);
 * ```
 *
 * @example
 * ```typescript
 * // 方法 2: 便利関数 optimizePrompt を使用
 * import { optimizePrompt } from "@/lib/promptOptimizer";
 *
 * const result = await optimizePrompt("gepa", task, {
 *   studentModel: "gemini-2.5-flash-lite",
 *   timeoutMs: 30_000,
 *   verbose: true,
 * });
 * ```
 */

// ── 型エクスポート ──
export type {
  Example,
  MetricFn,
  MetricScores,
  Demo,
  OptimizationProgress,
  OptimizerOptions,
  MetaPromptOptions,
  BootstrapFewShotOptions,
  GEPAOptions,
  OptimizationTask,
  OptimizationResult
} from "@/lib/promptOptimizer/types";

// ── クラスエクスポート ──
export { MetaPromptOptimizer } from "@/lib/promptOptimizer/MetaPromptOptimizer";
export { BootstrapFewShotOptimizer } from "@/lib/promptOptimizer/BootstrapFewShotOptimizer";
export { GEPAOptimizer } from "@/lib/promptOptimizer/GEPAOptimizer";

// ── ユーティリティエクスポート ──
export { OptimizationLogger } from "@/lib/promptOptimizer/logger";
export { TimeoutError, createDeadlineChecker, withTimeout } from "@/lib/promptOptimizer/timeout";

// ── 型インポート（便利関数の引数型定義に使用） ──
import type {
  OptimizationTask,
  OptimizationResult,
  OptimizationProgress,
  Demo,
  MetaPromptOptions,
  BootstrapFewShotOptions,
  GEPAOptions
} from "@/lib/promptOptimizer/types";
import { MetaPromptOptimizer } from "@/lib/promptOptimizer/MetaPromptOptimizer";
import { BootstrapFewShotOptimizer } from "@/lib/promptOptimizer/BootstrapFewShotOptimizer";
import { GEPAOptimizer } from "@/lib/promptOptimizer/GEPAOptimizer";

/**
 * 最適化手法を選択してプロンプトを最適化する便利関数。
 *
 * @param method - 最適化手法: "meta" | "bootstrap-fewshot" | "gepa"
 * @param task   - 最適化タスク（プロンプト・例・メトリクスを含む）
 * @param options - オプション（モデル選択・タイムアウト・ログ設定など）
 */
export async function optimizePrompt(
  method: "meta" | "bootstrap-fewshot" | "gepa",
  task: OptimizationTask,
  options?: {
    apiKey?: string;
    /** チューニング対象モデル（デフォルト: gemini-2.5-flash） */
    studentModel?: string;
    /** 改善生成モデル（デフォルト: gemini-2.5-flash） */
    teacherModel?: string;
    /** タイムアウト（ミリ秒）。超えたら途中でも打ち切り */
    timeoutMs?: number;
    /** trueでコンソールログ出力 */
    verbose?: boolean;
    /** 進捗コールバック */
    onProgress?: (progress: OptimizationProgress) => void;
    // MetaPrompt specific
    numRefinements?: number;
    maxFailures?: number;
    // BootstrapFewShot specific
    maxDemos?: number;
    maxRounds?: number;
    demoThreshold?: number;
    // GEPA specific
    numTrials?: number;
    minibatchSize?: number;
    maxIterations?: number;
    earlyStoppingTrials?: number;
  }
): Promise<OptimizationResult & { demos?: Demo[] }> {
  switch (method) {
    case "meta":
      return new MetaPromptOptimizer(options as MetaPromptOptions).optimize(task);

    case "bootstrap-fewshot":
      return new BootstrapFewShotOptimizer(options as BootstrapFewShotOptions).optimize(task);

    case "gepa":
      return new GEPAOptimizer(options as GEPAOptions).optimize(task);

    default: {
      const _exhaustive: never = method;
      throw new Error(`Unknown optimization method: ${_exhaustive}`);
    }
  }
}
