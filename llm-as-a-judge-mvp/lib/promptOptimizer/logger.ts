import type { OptimizationProgress } from "@/lib/promptOptimizer/types";

/**
 * 最適化ループの進捗ログを管理するクラス。
 * verbose=true でコンソール出力、onProgress コールバックでも通知。
 * ログは getLogs() で文字列配列として取得可能。
 */
export class OptimizationLogger {
  private readonly logs: string[] = [];
  private readonly startTime = Date.now();

  constructor(
    private readonly scope: string,
    private readonly verbose: boolean = false,
    private readonly onProgress?: (progress: OptimizationProgress) => void
  ) {}

  /** 一般ログメッセージを記録 */
  info(message: string): void {
    const entry = this.format("info", message);
    this.logs.push(entry);
    if (this.verbose) console.info(entry);
  }

  /** 進捗イベントを記録し、コールバックを呼び出す */
  progress(progress: Omit<OptimizationProgress, "elapsedMs">): void {
    const elapsed = this.elapsed();
    const full: OptimizationProgress = { ...progress, elapsedMs: elapsed };
    const trialStr = progress.trial != null ? ` trial=${progress.trial}` : "";
    const msgStr = progress.message ? ` | ${progress.message}` : "";
    const bestStr =
      progress.bestScores && Object.keys(progress.bestScores).length > 0
        ? Object.entries(progress.bestScores)
            .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
            .join(", ")
        : progress.bestScore.toFixed(3);
    const entry =
      `[${this.scope}] step=${progress.step}` +
      ` iter=${progress.iteration}${trialStr}` +
      ` current=${progress.currentScore.toFixed(3)}` +
      ` best=${bestStr}` +
      ` elapsed=${Math.round(elapsed / 1000)}s${msgStr}`;
    this.logs.push(entry);
    if (this.verbose) console.info(entry);
    this.onProgress?.(full);
  }

  /** 経過ミリ秒 */
  elapsed(): number {
    return Date.now() - this.startTime;
  }

  /** これまでのすべてのログエントリーを返す */
  getLogs(): string[] {
    return [...this.logs];
  }

  private format(level: string, message: string): string {
    const elapsed = Math.round(this.elapsed() / 1000);
    return `[${this.scope}] [+${elapsed}s] [${level}] ${message}`;
  }
}
