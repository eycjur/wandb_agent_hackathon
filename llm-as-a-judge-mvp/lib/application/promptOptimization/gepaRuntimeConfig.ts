/**
 * GEPA 最適化のループ階層（Ax ドキュメント・型定義より）:
 *
 * 階層: iteration > round > trial > metric_call
 *
 * - maxIterations (compile): 最上位。リフレクション→提案→評価の最大繰り返し数
 * - numTrials (コンストラクタ): 遺伝的探索の試行数。1 iteration 内の候補数
 * - round (onProgress): 評価バッチ1回 = 1 round。stagnationRounds も round ベース
 * - earlyStoppingTrials (コンストラクタ): trial ベース。何 trial 改善なしで停止するか
 * - earlyStoppingPatience (compile): round ベース。BootstrapFewShot 用。GEPA では未使用
 * - metric_call: メトリクス呼び出し回数（minibatch で 1 round あたり複数回）
 */
export type GepaCompileBudget = {
  numTrials: number;
  minibatchSize: number;
  earlyStoppingTrials: number;
  maxMetricCalls: number;
  maxIterations: number;
  compileTimeoutMs: number;
  metricCallTimeoutMs?: number;
  maxExamples: number;
  maxInputChars: number;
  maxOutputChars: number;
};

export const GEPA_JUDGE_FAST_UI_BUDGET: GepaCompileBudget = {
  numTrials: 3,
  minibatchSize: 3,
  earlyStoppingTrials: 1,
  maxMetricCalls: 3,
  maxIterations: 2,
  compileTimeoutMs: Number.MAX_SAFE_INTEGER,
  maxExamples: 6,
  maxInputChars: 1000,
  maxOutputChars: 1000
};

export const GEPA_TARGET_FAST_UI_BUDGET: GepaCompileBudget = {
  numTrials: 3,
  minibatchSize: 3,
  earlyStoppingTrials: 1,
  maxMetricCalls: 3,
  maxIterations: 2,
  compileTimeoutMs: Number.MAX_SAFE_INTEGER,
  maxExamples: 6,
  maxInputChars: 1000,
  maxOutputChars: 1000
};

export function truncateForGepa(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

/** UI からの上書きをデフォルト budget にマージ。compileTimeoutMs=0 は「無制限」として扱う */
export function mergeGepaBudgetWithOverrides(
  base: GepaCompileBudget,
  overrides?: {
    maxIterations?: number;
    numTrials?: number;
    earlyStoppingTrials?: number;
    compileTimeoutMs?: number;
    maxExamples?: number;
  } | null
): GepaCompileBudget {
  if (!overrides || Object.keys(overrides).length === 0) return base;
  return {
    ...base,
    ...(overrides.maxIterations != null && { maxIterations: overrides.maxIterations }),
    ...(overrides.numTrials != null && { numTrials: overrides.numTrials }),
    ...(overrides.earlyStoppingTrials != null && {
      earlyStoppingTrials: overrides.earlyStoppingTrials
    }),
    ...(overrides.compileTimeoutMs != null &&
      overrides.compileTimeoutMs > 0 && {
        compileTimeoutMs: overrides.compileTimeoutMs
      }),
    ...(overrides.maxExamples != null && { maxExamples: overrides.maxExamples })
  };
}
