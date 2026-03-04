type AxProgress = Readonly<{
  round: number;
  totalRounds: number;
  currentScore: number;
  bestScore: number;
  tokensUsed: number;
  timeElapsed: number;
  successfulExamples: number;
  totalExamples: number;
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
    console.info(
      `[ax-opt][${scope}] round=${progress.round}/${progress.totalRounds} current=${progress.currentScore.toFixed(3)} best=${progress.bestScore.toFixed(3)} best_delta=${trend} success=${progress.successfulExamples}/${progress.totalExamples} tokens=${progress.tokensUsed} elapsed=${formatSec(progress.timeElapsed)}`
    );
  };
}

export function createAxOptimizerEventLogger(scope: string) {
  return (event: AxOptimizerEvent): void => {
    const value =
      event.value == null
        ? ""
        : typeof event.value === "string"
          ? event.value
          : JSON.stringify(event.value);
    console.info(`[ax-opt][${scope}] step=${event.name}${value ? ` data=${value}` : ""}`);
  };
}

export function logAxOptimizationStart(scope: string, examplesCount: number): void {
  console.info(`[ax-opt][${scope}] start examples=${examplesCount}`);
}

export function logAxOptimizationDone(scope: string, bestScore: number): void {
  console.info(`[ax-opt][${scope}] done best=${bestScore.toFixed(3)}`);
}

export function createAxMetricLogger(scope: string) {
  let calls = 0;
  let best = Number.NEGATIVE_INFINITY;
  return (score: number): void => {
    calls += 1;
    if (score > best) best = score;
    console.info(
      `[ax-opt][${scope}] round=${calls} metric=${score.toFixed(3)} best_metric=${best.toFixed(3)}`
    );
  };
}

export function createAxMultiMetricLogger(scope: string) {
  let calls = 0;
  const bestByMetric = new Map<string, number>();
  return (metrics: Record<string, number>): void => {
    calls += 1;
    const parts: string[] = [];
    for (const [name, rawValue] of Object.entries(metrics)) {
      const value = Number.isFinite(rawValue) ? rawValue : 0;
      const prevBest = bestByMetric.get(name) ?? Number.NEGATIVE_INFINITY;
      const nextBest = value > prevBest ? value : prevBest;
      bestByMetric.set(name, nextBest);
      parts.push(`${name}=${value.toFixed(3)}`);
      parts.push(`best_${name}=${nextBest.toFixed(3)}`);
    }
    console.info(`[ax-opt][${scope}] round=${calls} ${parts.join(" ")}`);
  };
}
