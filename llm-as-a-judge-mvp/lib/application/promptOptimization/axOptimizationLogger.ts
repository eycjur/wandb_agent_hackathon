/**
 * 最適化ループの用語整理（Ax ドキュメント・型定義より）:
 *
 * - round (opt_round): onProgress の round。1ラウンド = 候補評価の1バッチ完了。
 *   収束判定の stagnationRounds も round ベース。
 *
 * - iteration: compile の maxIterations。最上位ループの最大繰り返し数。
 *   GEPA では「リフレクション→提案→評価」の1サイクルが1 iteration。
 *
 * - trial: GEPA/MiPRO の numTrials（コンストラクタ）。遺伝的探索での試行数。
 *   1 iteration 内で複数 trial を評価する。
 *
 * - earlyStoppingPatience: compile オプション。round ベース。
 *   「何 round 改善なしで停止するか」。BootstrapFewShot 等で使用。
 *
 * - earlyStoppingTrials: オプティマイザコンストラクタ（GEPA, MiPRO）。trial ベース。
 *   「何 trial 改善なしで停止するか」。
 *
 * - metric_call: メトリクス関数の呼び出し回数。1 round 内で minibatch なら複数回。
 *
 * - event: ライフサイクルイベント（OptimizationStart, RoundProgress, OptimizationComplete 等）。
 */

type AxProgress = Readonly<{
  round: number;
  totalRounds: number;
  currentScore: number;
  bestScore: number;
  tokensUsed: number;
  timeElapsed: number;
  successfulExamples: number;
  totalExamples: number;
  convergenceInfo?: { stagnationRounds?: number; improvement?: number; isConverging?: boolean };
}>;

type AxOptimizerEvent = Readonly<{
  name: string;
  value?: unknown;
}>;

function formatSec(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

export function createAxProgressLogger(scope: string) {
  let prevBest = Number.NEGATIVE_INFINITY;
  return (progress: AxProgress): void => {
    const deltaBest =
      Number.isFinite(prevBest) && prevBest !== Number.NEGATIVE_INFINITY
        ? progress.bestScore - prevBest
        : 0;
    prevBest = progress.bestScore;
    const trend =
      deltaBest > 0 ? `+${deltaBest.toFixed(3)}` : deltaBest < 0 ? deltaBest.toFixed(3) : "0.000";
    const hierarchy = `[階層:round ${progress.round}/${progress.totalRounds}]`;
    const stagnation =
      progress.convergenceInfo?.stagnationRounds != null
        ? ` stagnationRounds=${progress.convergenceInfo.stagnationRounds}`
        : "";
    console.info(
      `[ax-opt][${scope}] ${hierarchy} current=${progress.currentScore.toFixed(3)} best=${progress.bestScore.toFixed(3)} best_delta=${trend} success=${progress.successfulExamples}/${progress.totalExamples} tokens=${progress.tokensUsed} elapsed=${formatSec(progress.timeElapsed)}${stagnation}`
    );
  };
}

const EVENT_HIERARCHY_KEYS = [
  "iteration",
  "round",
  "totalRounds",
  "trial",
  "currentScore",
  "bestScore",
  "exampleCount",
  "validationCount",
  "stagnationRounds"
] as const;

function extractNumber(obj: unknown, key: string): number | undefined {
  if (obj == null || typeof obj !== "object") return undefined;
  const v = (obj as Record<string, unknown>)[key];
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function createAxOptimizerEventLogger(scope: string) {
  let prevIteration: number | undefined;
  let prevTrial: number | undefined;

  return (event: AxOptimizerEvent): void => {
    if (event.value == null || typeof event.value !== "object") {
      console.info(`[ax-opt][${scope}] event=${event.name}`);
      return;
    }

    const raw = event.value as Record<string, unknown>;
    const hierarchy: Record<string, number> = {};
    for (const key of EVENT_HIERARCHY_KEYS) {
      let value = extractNumber(raw, key);
      if (value == null && (key === "iteration" || key === "trial")) {
        const config = raw.config ?? raw.configuration;
        value = extractNumber(config, key);
      }
      if (value != null) hierarchy[key] = value;
    }

    const currIteration = hierarchy.iteration;
    const currTrial = hierarchy.trial;

    if (currIteration != null && currIteration !== prevIteration) {
      const from = prevIteration ?? 0;
      console.info(`[ax-opt][${scope}] iteration updated: ${from} -> ${currIteration}`);
      prevIteration = currIteration;
    }
    if (currTrial != null && currTrial !== prevTrial) {
      const from = prevTrial ?? 0;
      console.info(`[ax-opt][${scope}] trial updated: ${from} -> ${currTrial}`);
      prevTrial = currTrial;
    }

    const hierarchyStr =
      Object.keys(hierarchy).length > 0
        ? ` [階層: ${Object.entries(hierarchy)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")}]`
        : "";
    console.info(`[ax-opt][${scope}] event=${event.name}${hierarchyStr}`);
  };
}

export type AxOptimizationStartBudget = {
  maxIterations?: number;
  numTrials?: number;
  /** BootstrapFewShot の maxRounds */
  maxRounds?: number;
};

export function logAxOptimizationStart(
  scope: string,
  examplesCount: number,
  budget?: AxOptimizationStartBudget
): void {
  const budgetParts: string[] = [];
  if (budget?.maxIterations != null) budgetParts.push(`maxIterations=${budget.maxIterations}`);
  if (budget?.numTrials != null) budgetParts.push(`numTrials=${budget.numTrials}`);
  if (budget?.maxRounds != null) budgetParts.push(`maxRounds=${budget.maxRounds}`);
  const budgetStr =
    budgetParts.length > 0 ? ` [階層: ${budgetParts.join(" ")}]` : "";
  console.info(
    `[ax-opt][${scope}] start [階層: iteration→round→trial→metric_call]${budgetStr} examples=${examplesCount}`
  );
}

export function logAxOptimizationDone(scope: string, bestScore: number): void {
  console.info(`[ax-opt][${scope}] done [階層: 完了] best=${bestScore.toFixed(3)}`);
}

export function createAxMetricLogger(scope: string) {
  let metricCalls = 0;
  let best = Number.NEGATIVE_INFINITY;
  return (score: number): void => {
    metricCalls += 1;
    if (score > best) best = score;
    console.info(
      `[ax-opt][${scope}] [階層:metric_call ${metricCalls}] metric=${score.toFixed(3)} best_metric=${best.toFixed(3)}`
    );
  };
}

export type AxMetricContext = Record<string, string | number | undefined>;

export function createAxMultiMetricLogger(scope: string) {
  let metricCalls = 0;
  const bestByMetric = new Map<string, number>();
  return (metrics: Record<string, number>, context?: AxMetricContext): void => {
    metricCalls += 1;
    const parts: string[] = [];
    for (const [name, rawValue] of Object.entries(metrics)) {
      const value = Number.isFinite(rawValue) ? rawValue : 0;
      const prevBest = bestByMetric.get(name) ?? Number.NEGATIVE_INFINITY;
      const nextBest = value > prevBest ? value : prevBest;
      bestByMetric.set(name, nextBest);
      parts.push(`${name}=${value.toFixed(3)}`);
      parts.push(`best_${name}=${nextBest.toFixed(3)}`);
    }
    const ctxParts: string[] = [];
    if (context) {
      if (context.humanScore != null) ctxParts.push(`人間スコア=${context.humanScore}`);
      if (context.predScore != null) ctxParts.push(`自動評価(Judge)=${context.predScore}`);
    }
    const ctxStr = ctxParts.length > 0 ? ` | ${ctxParts.join(" ")}` : "";
    console.info(`[ax-opt][${scope}] [階層:metric_call ${metricCalls}] ${parts.join(" ")}${ctxStr}`);
  };
}
