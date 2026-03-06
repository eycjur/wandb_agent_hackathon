/**
 * MetaPromptOptimizer — イテレーティブなメタプロンプト最適化
 *
 * 参考論文: "Large Language Models as Optimizers" (OPRO)
 * Yang et al., ICLR 2024 — arXiv:2309.03409
 *
 * アルゴリズム概要:
 * 1. 初期プロンプトをトレーニング例で評価
 * 2. 失敗した例を収集し、Teacher LLM に渡す
 * 3. Teacher が「なぜ失敗したか」を踏まえて改善プロンプトを提案
 * 4. 改善プロンプトを評価し、ベストより良ければ採用
 * 5. numRefinements 回繰り返す（タイムアウトで打ち切り可）
 *
 * 最もシンプルな最適化手法で、少ない試行でも効果を発揮する。
 */
import type { OptimizationTask, OptimizationResult, MetaPromptOptions } from "@/lib/promptOptimizer/types";
import { OptimizationLogger } from "@/lib/promptOptimizer/logger";
import { createDeadlineChecker } from "@/lib/promptOptimizer/timeout";
import {
  createGeminiClient,
  evaluatePrompt,
  runTeacher
} from "@/lib/promptOptimizer/runner";

const DEFAULT_STUDENT_MODEL = "gemini-2.5-flash";
const DEFAULT_TEACHER_MODEL = "gemini-2.5-flash";

export class MetaPromptOptimizer {
  private readonly numRefinements: number;
  private readonly maxFailures: number;
  private readonly options: MetaPromptOptions;

  constructor(options: MetaPromptOptions = {}) {
    this.numRefinements = options.numRefinements ?? 3;
    this.maxFailures = options.maxFailures ?? 5;
    this.options = options;
  }

  async optimize(task: OptimizationTask): Promise<OptimizationResult> {
    const {
      studentModel = DEFAULT_STUDENT_MODEL,
      teacherModel = DEFAULT_TEACHER_MODEL,
      timeoutMs,
      verbose = false,
      onProgress
    } = this.options;

    const logger = new OptimizationLogger("meta-prompt", verbose, onProgress);
    const isDeadlineExceeded = createDeadlineChecker(timeoutMs);
    const client = createGeminiClient(this.options.apiKey);

    logger.info(
      `start studentModel=${studentModel} teacherModel=${teacherModel}` +
        ` numRefinements=${this.numRefinements} examples=${task.examples.length}`
    );

    // ── Step 1: 初期プロンプトを評価 ──
    logger.info("初期プロンプトを評価中...");
    const initial = await evaluatePrompt(client, studentModel, task.initialPrompt, task);
    const initialScore = initial.score;

    logger.progress({
      step: "init",
      iteration: 0,
      currentScore: initialScore,
      bestScore: initialScore,
      message: `初期スコア=${initialScore.toFixed(3)}`
    });

    let bestPrompt = task.initialPrompt;
    let bestScore = initialScore;
    let currentPredictions = initial.predictions;
    let iterations = 0;
    let timedOut = false;

    // 最適化の履歴（OPRO 流に見せるため記録）
    const history: Array<{ score: number; promptSnippet: string }> = [
      { score: initialScore, promptSnippet: task.initialPrompt.slice(0, 300) }
    ];

    // ── Step 2: 改善ループ ──
    for (let i = 1; i <= this.numRefinements; i++) {
      if (isDeadlineExceeded()) {
        logger.info("タイムアウトにより早期終了");
        timedOut = true;
        break;
      }

      logger.info(`=== 改善ラウンド ${i}/${this.numRefinements} ===`);

      // 失敗例を収集
      const failures = currentPredictions
        .filter((r) => r.score < 0.5)
        .slice(0, this.maxFailures);

      // 失敗例を整形
      const failureStr =
        failures.length > 0
          ? failures
              .map((f, idx) => {
                const inputStr = Object.entries(f.example.inputs)
                  .map(([k, v]) => `  ${k}: ${v.slice(0, 300)}`)
                  .join("\n");
                const predStr = Object.entries(f.prediction)
                  .map(([k, v]) => `  ${k}: ${v}`)
                  .join("\n");
                const expectedStr = f.example.expectedOutputs
                  ? Object.entries(f.example.expectedOutputs)
                      .map(([k, v]) => `  ${k}: ${v}`)
                      .join("\n")
                  : "  (未指定)";
                return (
                  `失敗例 ${idx + 1} (スコア ${f.score.toFixed(2)}):\n` +
                  `  入力:\n${inputStr}\n` +
                  `  予測:\n${predStr}\n` +
                  `  期待:\n${expectedStr}`
                );
              })
              .join("\n\n")
          : "失敗例なし（スコアが低い例がありません）";

      // 最適化履歴を整形（直近5件）
      const historyStr = history
        .slice(-5)
        .map((h, idx) => `  試行 ${idx + 1}: スコア=${h.score.toFixed(3)} | プロンプト頭部: ${h.promptSnippet.slice(0, 100)}...`)
        .join("\n");

      // Teacher へのメタプロンプト
      const metaPrompt =
        `あなたはAIシステムのプロンプトエンジニアです。以下のプロンプトを改善してください。\n\n` +
        `【現在のプロンプト】\n"""\n${bestPrompt}\n"""\n\n` +
        `【現在のスコア】: ${bestScore.toFixed(3)} / 1.0\n\n` +
        `【失敗した例】\n${failureStr}\n\n` +
        `【これまでの最適化履歴】\n${historyStr}\n\n` +
        `改善したプロンプトを作成してください。改善点:\n` +
        `1. 失敗例の問題点を解決する\n` +
        `2. 元のタスクの意図を維持する\n` +
        `3. 明確で具体的な指示にする\n` +
        `4. 過去の失敗した試みとは異なるアプローチをとる\n\n` +
        `改善後のプロンプトのテキストだけを返してください（説明は不要）。`;

      // Teacher に改善案を生成させる
      logger.info(`Teacher (${teacherModel}) に改善プロンプトを生成依頼中...`);
      let improvedPrompt: string;
      try {
        improvedPrompt = await runTeacher(client, teacherModel, metaPrompt, 0.7);
      } catch (err) {
        logger.info(
          `ラウンド ${i}: Teacher 呼び出し失敗 — ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }

      if (!improvedPrompt || improvedPrompt.length < 10) {
        logger.info(`ラウンド ${i}: Teacher が空の応答を返したためスキップ`);
        continue;
      }

      // 改善プロンプトを評価
      logger.info(`ラウンド ${i}: 改善プロンプトを評価中...`);
      const evalResult = await evaluatePrompt(client, studentModel, improvedPrompt, task);
      const newScore = evalResult.score;

      history.push({
        score: newScore,
        promptSnippet: improvedPrompt.slice(0, 300)
      });
      iterations = i;

      logger.progress({
        step: "refine",
        iteration: i,
        currentScore: newScore,
        bestScore: Math.max(bestScore, newScore),
        message: `スコア=${newScore.toFixed(3)} (ベスト=${Math.max(bestScore, newScore).toFixed(3)})`
      });

      if (newScore > bestScore) {
        bestScore = newScore;
        bestPrompt = improvedPrompt;
        currentPredictions = evalResult.predictions;
        logger.info(`ラウンド ${i}: 改善! 新ベストスコア=${bestScore.toFixed(3)}`);
      } else {
        logger.info(
          `ラウンド ${i}: 改善なし (${newScore.toFixed(3)} <= ${bestScore.toFixed(3)})`
        );
      }
    }

    logger.info(
      `完了 iterations=${iterations} bestScore=${bestScore.toFixed(3)} timedOut=${timedOut}`
    );

    return {
      optimizedPrompt: bestPrompt,
      bestScore,
      initialScore,
      iterations,
      timedOut,
      log: logger.getLogs()
    };
  }
}
