/**
 * Prompt Optimization Library — Core Types
 *
 * 3つの最適化手法を提供する汎用プロンプト最適化ライブラリ:
 *
 * - MetaPromptOptimizer: LLMを使ったイテレーティブな改善
 *   (OPRO: "Large Language Models as Optimizers", Yang et al., ICLR 2024)
 *
 * - BootstrapFewShotOptimizer: DSPy流のBootstrap Few-Shot
 *   (Khattab et al., 2023 — DSPy: Compiling Declarative LM Calls into Self-Improving Pipelines)
 *
 * - GEPAOptimizer: 反省的プロンプト進化
 *   (Gallotta et al., ICLR 2026 — "GEPA: Reflective Prompt Evolution Can Outperform RL", arXiv:2507.19457)
 */

/** 最適化に使用する1件のトレーニング例 */
export interface Example {
  /** LLMへの入力フィールド */
  inputs: Record<string, string>;
  /** 期待される出力（メトリクス計算に使用） */
  expectedOutputs?: Record<string, string>;
}

/** 多目的メトリクスのスコアベクトル（各目的は 0..1） */
export type MetricScores = Record<string, number>;

/**
 * メトリクス関数: LLMの予測を評価する
 * @returns スカラー（0..1）または多目的の Record<string, number>（各値 0..1）
 */
export type MetricFn = (
  prediction: Record<string, string>,
  example: Example
) => number | MetricScores | Promise<number> | Promise<MetricScores>;

/** Few-shot デモ例（入力＋出力のペア） */
export interface Demo {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
}

/** 最適化の進捗イベント */
export interface OptimizationProgress {
  /** 現在のステップ名（"init", "refine", "bootstrap", "reflect", "trial" など） */
  step: string;
  /** 現在のイテレーション番号 */
  iteration: number;
  /** GEPA内のトライアル番号 */
  trial?: number;
  /** 現在のスコア（スカラー。多目的時は第一目的） */
  currentScore: number;
  /** これまでのベストスコア（スカラー。多目的時は第一目的） */
  bestScore: number;
  /** 開始からの経過ミリ秒 */
  elapsedMs: number;
  /** 追加メッセージ */
  message?: string;
  /** 多目的時: ベストのスコアベクトル（ログ用） */
  bestScores?: MetricScores;
}

/** 全オプティマイザーに共通のオプション */
export interface OptimizerOptions {
  /** Gemini APIキー。未指定時は GEMINI_API_KEY 環境変数を使用 */
  apiKey?: string;
  /**
   * チューニング対象モデル（プログラムを実行するモデル）
   * デフォルト: "gemini-2.5-flash"
   */
  studentModel?: string;
  /**
   * 改善を生成するモデル（GEPA/FewShotのTeacher）
   * デフォルト: "gemini-2.5-flash"
   * より高性能なモデルを指定すると改善品質が上がる
   */
  teacherModel?: string;
  /**
   * タイムアウト（ミリ秒）。指定した時間が経過すると途中でも打ち切り、
   * それまでのベスト結果を返す
   */
  timeoutMs?: number;
  /** trueにするとコンソールに進捗ログを出力 */
  verbose?: boolean;
  /** 進捗コールバック */
  onProgress?: (progress: OptimizationProgress) => void;
}

/** MetaPromptOptimizer のオプション */
export interface MetaPromptOptions extends OptimizerOptions {
  /** 改善ラウンド数（デフォルト: 3） */
  numRefinements?: number;
  /** Teacher に渡す失敗例の最大件数（デフォルト: 5） */
  maxFailures?: number;
}

/** BootstrapFewShotOptimizer のオプション */
export interface BootstrapFewShotOptions extends OptimizerOptions {
  /** Few-shot デモの最大件数（デフォルト: 4） */
  maxDemos?: number;
  /** Bootstrap ラウンド数（デフォルト: 3） */
  maxRounds?: number;
  /** デモとして採用するメトリクスの閾値（デフォルト: 0.5） */
  demoThreshold?: number;
}

/** GEPAOptimizer のオプション */
export interface GEPAOptions extends OptimizerOptions {
  /**
   * イテレーションごとに生成する候補プロンプト数（デフォルト: 3）
   * 多いほど探索が広がるが時間がかかる
   */
  numTrials?: number;
  /**
   * 反省フェーズで評価するサンプル数（デフォルト: 4）
   * 全トレーニング例のサブセット
   */
  minibatchSize?: number;
  /** 最大イテレーション数（デフォルト: 5） */
  maxIterations?: number;
  /**
   * 改善がない場合に早期終了するイテレーション数（デフォルト: 2）
   * earlyStoppingTrials回連続で改善なしなら停止
   */
  earlyStoppingTrials?: number;
}

/** 最適化タスクの仕様 */
export interface OptimizationTask {
  /** 最適化するプロンプト（初期値） */
  initialPrompt: string;
  /** 入力フィールド名のリスト（例: ["question", "context"]） */
  inputFields: string[];
  /** 出力フィールド名のリスト（例: ["answer"]） */
  outputFields: string[];
  /** トレーニング例 */
  examples: Example[];
  /** 評価メトリクス関数（0..1を返す） */
  metric: MetricFn;
  /**
   * 初期プロンプト評価時のキャッシュ（例: Weave の judgeResult）。
   * instruction === initialPrompt のときのみ使用。各要素は outputFields に対応。
   */
  cachedPredictions?: Array<Record<string, string> | undefined>;
}

/** 最適化の結果 */
export interface OptimizationResult {
  /** 最終的な最適化プロンプト */
  optimizedPrompt: string;
  /** 達成した最高スコア（0..1）。多目的時はスカラー化後の値 */
  bestScore: number;
  /** 初期プロンプトのスコア */
  initialScore: number;
  /** 実行したイテレーション数 */
  iterations: number;
  /** タイムアウトで打ち切られた場合 true */
  timedOut: boolean;
  /** 時系列の最適化ログ */
  log: string[];
  /** BootstrapFewShot で選択されたデモ例（その手法の場合のみ） */
  demos?: Demo[];
  /** 多目的時: Pareto frontier の各解のスコアベクトル */
  paretoFront?: Array<{ prompt: string; scores: MetricScores }>;
}
