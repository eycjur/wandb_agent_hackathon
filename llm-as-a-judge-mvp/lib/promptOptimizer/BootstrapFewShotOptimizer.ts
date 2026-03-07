/**
 * BootstrapFewShotOptimizer — DSPy流 Bootstrap Few-Shot 最適化
 *
 * 参考: DSPy "Compiling Declarative Language Model Calls into Self-Improving Pipelines"
 * Khattab et al., 2023 — https://arxiv.org/abs/2310.03714
 *
 * アルゴリズム概要（BootstrapFewShot の本質）:
 *
 * Phase 1 — Bootstrap:
 *   Teacher モデルを使って各トレーニング例を解かせる。
 *   メトリクスが閾値以上の例を「成功デモ」として収集する。
 *   ポイント: モデル自身の成功した出力をデモに使う（人手でデモを書く必要がない）。
 *
 * Phase 2 — 選択:
 *   成功デモをスコア降順にソート。
 *   多様性のために上位 + ランダムサンプルを組み合わせてデモセットを構成。
 *
 * Phase 3 — コンパイル:
 *   デモをプロンプトに埋め込んだ Few-shot プロンプトを生成。
 *   Student モデルで評価し、最良のデモセットを返す。
 *
 * maxRounds ラウンド繰り返してベストを選択。タイムアウトで打ち切り可。
 */
import type {
  OptimizationTask,
  OptimizationResult,
  BootstrapFewShotOptions,
  Demo
} from "@/lib/promptOptimizer/types";
import { OptimizationLogger } from "@/lib/promptOptimizer/logger";
import { createDeadlineChecker } from "@/lib/promptOptimizer/timeout";
import {
  createGeminiClient,
  runProgram,
  evaluatePrompt,
  sampleRandom,
  normalizeMetricResult
} from "@/lib/promptOptimizer/runner";

const DEFAULT_STUDENT_MODEL = "gemini-2.5-flash";
const DEFAULT_TEACHER_MODEL = "gemini-2.5-flash";

export class BootstrapFewShotOptimizer {
  private readonly maxDemos: number;
  private readonly maxRounds: number;
  private readonly demoThreshold: number;
  private readonly options: BootstrapFewShotOptions;

  constructor(options: BootstrapFewShotOptions = {}) {
    this.maxDemos = options.maxDemos ?? 4;
    this.maxRounds = options.maxRounds ?? 3;
    this.demoThreshold = options.demoThreshold ?? 0.5;
    this.options = options;
  }

  async optimize(task: OptimizationTask): Promise<OptimizationResult & { demos: Demo[] }> {
    const {
      studentModel = DEFAULT_STUDENT_MODEL,
      teacherModel = DEFAULT_TEACHER_MODEL,
      timeoutMs,
      verbose = false,
      onProgress
    } = this.options;

    const logger = new OptimizationLogger("bootstrap-fewshot", verbose, onProgress);
    const isDeadlineExceeded = createDeadlineChecker(timeoutMs);
    const client = createGeminiClient(this.options.apiKey);

    logger.info(
      `start studentModel=${studentModel} teacherModel=${teacherModel}` +
        ` maxDemos=${this.maxDemos} maxRounds=${this.maxRounds}` +
        ` demoThreshold=${this.demoThreshold} examples=${task.examples.length}`
    );

    // ── Phase 0: 初期プロンプトを評価（ベースライン） ──
    logger.info("初期プロンプトを評価中（デモなし）...");
    const initial = await evaluatePrompt(client, studentModel, task.initialPrompt, task);
    const initialScore = initial.score;

    logger.progress({
      step: "init",
      iteration: 0,
      currentScore: initialScore,
      bestScore: initialScore,
      message: `初期スコア=${initialScore.toFixed(3)}`
    });

    // ── Phase 1: Bootstrap — Teacher でデモ候補を生成（並列） ──
    logger.info("Bootstrap フェーズ: Teacher モデルで成功例を生成中...");

    type BootstrapDemo = {
      inputs: Record<string, string>;
      outputs: Record<string, string>;
      score: number;
    };

    const bootstrapResults = await Promise.all(
      task.examples.map(async (example) => {
        try {
          // Teacher が解く（Teacher は smarter なモデルでも可）
          const teacherPred = await runProgram(
            client,
            teacherModel,
            task.initialPrompt,
            example.inputs,
            task.outputFields
          );
          const rawScore = await task.metric(teacherPred, example);
          const score = Math.max(0, Math.min(1, normalizeMetricResult(rawScore).scalar));

          if (score >= this.demoThreshold) {
            return { inputs: example.inputs, outputs: teacherPred, score } satisfies BootstrapDemo;
          }
          return null;
        } catch (err) {
          logger.info(
            `Bootstrap: 例の評価失敗 — ${err instanceof Error ? err.message : String(err)}`
          );
          return null;
        }
      })
    );

    const bootstrapped = bootstrapResults.filter((r): r is BootstrapDemo => r != null);

    logger.info(
      `Bootstrap 完了: ${bootstrapped.length}/${task.examples.length} 件がデモ候補として採用`
    );

    if (bootstrapped.length === 0) {
      logger.info("デモ候補が0件のため初期プロンプトをそのまま返す");
      return {
        optimizedPrompt: task.initialPrompt,
        bestScore: initialScore,
        initialScore,
        iterations: 0,
        timedOut: isDeadlineExceeded(),
        log: logger.getLogs(),
        demos: []
      };
    }

    // スコア降順にソート
    bootstrapped.sort((a, b) => b.score - a.score);

    // ── Phase 2 & 3: デモ選択とコンパイル ──
    let bestPrompt = task.initialPrompt;
    let bestDemos: Demo[] = [];
    let bestScore = initialScore;
    let iterations = 0;
    let timedOut = false;

    for (let round = 1; round <= this.maxRounds; round++) {
      if (isDeadlineExceeded()) {
        timedOut = true;
        break;
      }

      // 上位固定 + ランダムで多様性を確保
      const topCount = Math.ceil(this.maxDemos / 2);
      const randCount = Math.floor(this.maxDemos / 2);
      const topDemos = bootstrapped.slice(0, topCount);
      const rest = bootstrapped.slice(topCount);
      const randDemos = sampleRandom(rest, randCount);
      const selected = [...topDemos, ...randDemos].slice(0, this.maxDemos);

      // Few-shot プロンプトを構築
      const fewShotPrompt = buildFewShotPrompt(
        task.initialPrompt,
        selected,
        task.inputFields,
        task.outputFields
      );

      // Student モデルで評価
      logger.info(
        `ラウンド ${round}/${this.maxRounds}: ${selected.length} 件のデモで評価中...`
      );
      const evalResult = await evaluatePrompt(client, studentModel, fewShotPrompt, task);
      const roundScore = evalResult.score;

      iterations = round;
      logger.progress({
        step: "round",
        iteration: round,
        currentScore: roundScore,
        bestScore: Math.max(bestScore, roundScore),
        message: `スコア=${roundScore.toFixed(3)} デモ数=${selected.length}`
      });

      // DSPy BootstrapFewShot の慣例に従い、同スコアでも few-shot プロンプトを優先する
      // （デモあり = より汎化しやすい可能性があるため）
      if (roundScore >= bestScore) {
        const improved = roundScore > bestScore;
        bestScore = roundScore;
        bestPrompt = fewShotPrompt;
        bestDemos = selected.map((d) => ({ inputs: d.inputs, outputs: d.outputs }));
        logger.info(
          improved
            ? `ラウンド ${round}: 改善! ベストスコア=${bestScore.toFixed(3)}`
            : `ラウンド ${round}: スコア同一だが few-shot プロンプトを採用 (score=${bestScore.toFixed(3)})`
        );
      }
    }

    logger.info(
      `完了 iterations=${iterations} bestScore=${bestScore.toFixed(3)}` +
        ` demos=${bestDemos.length} timedOut=${timedOut}`
    );

    return {
      optimizedPrompt: bestPrompt,
      bestScore,
      initialScore,
      iterations,
      timedOut,
      log: logger.getLogs(),
      demos: bestDemos
    };
  }
}

/**
 * Few-shot プロンプトを構築する。
 * 形式:
 *   [instruction]
 *
 *   例:
 *   ---
 *   入力:
 *     field1: value
 *   出力:
 *     field1: value
 *   ---
 *
 *   次のタスクを実行してください:
 */
function buildFewShotPrompt(
  instruction: string,
  demos: Array<{ inputs: Record<string, string>; outputs: Record<string, string> }>,
  inputFields: string[],
  outputFields: string[]
): string {
  const lines: string[] = [instruction, ""];

  if (demos.length > 0) {
    lines.push("以下は参考例です:");
    for (const demo of demos) {
      lines.push("---");
      lines.push("入力:");
      for (const field of inputFields) {
        lines.push(`  ${field}: ${demo.inputs[field] ?? ""}`);
      }
      lines.push("出力:");
      for (const field of outputFields) {
        lines.push(`  ${field}: ${demo.outputs[field] ?? ""}`);
      }
    }
    lines.push("---");
    lines.push("");
    lines.push("上記の例を参考に、次のタスクを実行してください:");
  }

  return lines.join("\n");
}
