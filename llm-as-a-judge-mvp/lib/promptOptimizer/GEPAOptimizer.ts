/**
 * GEPAOptimizer — 反省的プロンプト進化 (Reflective Prompt Evolution)
 *
 * 参考論文: "GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning"
 * Gallotta et al., ICLR 2026 — arXiv:2507.19457
 *
 * ─────────────────────────────────────────────────
 * アルゴリズムの本質:
 *
 * 1. Actionable Side Information (ASI) / 反省 (Reflection)
 * 2. Pareto Frontier (多様な候補集団) — 多目的最適化対応
 * 3. インスタンスフロント頻度による親選択 (Algorithm 2)
 * 4. Merge (候補の合成)
 *
 * ─────────────────────────────────────────────────
 * ループ階層:
 *   iteration（最外ループ）
 *     └─ 全データ評価（並列）→ 反省生成
 *       └─ trial（候補生成）× numTrials
 *         └─ 親をインスタンスフロント頻度で選択 → 候補を全データで評価（並列）→ 採用判定
 *     └─ merge ステップ（2候補を合成）
 */
import { GoogleGenAI } from "@google/genai";
import type {
  OptimizationTask,
  OptimizationResult,
  GEPAOptions,
  Example,
  MetricScores
} from "@/lib/promptOptimizer/types";
import { OptimizationLogger } from "@/lib/promptOptimizer/logger";
import { createDeadlineChecker } from "@/lib/promptOptimizer/timeout";
import {
  createGeminiClient,
  runProgram,
  evaluatePrompt,
  runTeacher
} from "@/lib/promptOptimizer/runner";
import {
  avgVec,
  buildParetoFront,
  buildInstanceFronts,
  buildInstanceFrontsFromVectors,
  selectParentByInstanceFronts,
  sumVec,
  isDominatedByAny,
  type ScoreVector
} from "@/lib/promptOptimizer/paretoUtils";

const DEFAULT_STUDENT_MODEL = "gemini-2.5-flash";
const DEFAULT_TEACHER_MODEL = "gemini-2.5-flash";
const TIE_EPSILON = 1e-9;

/** Pareto Frontier に保存する候補エントリー */
type PopulationEntry = {
  prompt: string;
  score: number;
  /** 多目的時: 平均スコアベクトル */
  scores?: ScoreVector;
  /** スカラー時: 各 example のスコア。多目的時: 各 example のベクトル */
  perInstance: number[] | ScoreVector[];
  reflection?: string;
  iteration: number;
};

export class GEPAOptimizer {
  private readonly numTrials: number;
  private readonly maxIterations: number;
  private readonly earlyStoppingTrials: number;
  private readonly options: GEPAOptions;

  constructor(options: GEPAOptions = {}) {
    this.numTrials = options.numTrials ?? 3;
    this.maxIterations = options.maxIterations ?? 5;
    this.earlyStoppingTrials = options.earlyStoppingTrials ?? 2;
    this.options = options;
  }

  private getPerInstance(
    predictions: Array<{ score: number; scores?: MetricScores }>
  ): number[] | ScoreVector[] {
    const first = predictions[0];
    if (first?.scores && Object.keys(first.scores).length > 0) {
      return predictions.map((p) => (p.scores ?? {}) as ScoreVector);
    }
    return predictions.map((p) => p.score);
  }

  private isMultiObjective(perInstance: number[] | ScoreVector[]): perInstance is ScoreVector[] {
    return (
      perInstance.length > 0 &&
      typeof perInstance[0] === "object" &&
      perInstance[0] !== null &&
      !Array.isArray(perInstance[0])
    );
  }

  private getMetricKeys(scores: ScoreVector): string[] {
    return Object.keys(scores);
  }

  private formatScoresForLog(scores: ScoreVector | undefined): string {
    if (!scores || Object.keys(scores).length === 0) return "";
    return Object.entries(scores)
      .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
      .join(", ");
  }

  async optimize(task: OptimizationTask): Promise<OptimizationResult> {
    const {
      studentModel = DEFAULT_STUDENT_MODEL,
      teacherModel = DEFAULT_TEACHER_MODEL,
      timeoutMs,
      verbose = false,
      onProgress
    } = this.options;

    const logger = new OptimizationLogger("gepa", verbose, onProgress);
    const isDeadlineExceeded = createDeadlineChecker(timeoutMs);
    const client = createGeminiClient(this.options.apiKey);
    const rand = () => Math.random();

    logger.info(
      `start studentModel=${studentModel} teacherModel=${teacherModel}` +
        ` numTrials=${this.numTrials} maxIterations=${this.maxIterations}` +
        ` earlyStoppingTrials=${this.earlyStoppingTrials} examples=${task.examples.length}`
    );

    // ── 初期評価 ──
    logger.info("初期プロンプトを評価中...");
    const initEvalStart = Date.now();
    const initialEval = await evaluatePrompt(
      client,
      studentModel,
      task.initialPrompt,
      task
    );
    logger.info(
      `初期評価: ${task.examples.length}件, ${(Date.now() - initEvalStart) / 1000}s`
    );
    const initialPerInstance = this.getPerInstance(
      initialEval.predictions.map((p) => ({ score: p.score, scores: p.scores }))
    );
    const initialScoresVec =
      initialEval.scoresPerExample && initialEval.scoresPerExample.length > 0
        ? avgVec(initialEval.scoresPerExample)
        : undefined;
    const initialScore = initialEval.score;
    const isMultiObj = this.isMultiObjective(initialPerInstance);
    const metricKeys =
      initialScoresVec && Object.keys(initialScoresVec).length > 0
        ? this.getMetricKeys(initialScoresVec)
        : ["score"];

    logger.progress({
      step: "init",
      iteration: 0,
      currentScore: initialScore,
      bestScore: initialScore,
      bestScores: initialScoresVec,
      message: isMultiObj && initialScoresVec
        ? `初期スコア=${this.formatScoresForLog(initialScoresVec)}`
        : `初期スコア=${initialScore.toFixed(3)}`
    });

    const population: PopulationEntry[] = [
      {
        prompt: task.initialPrompt,
        score: initialScore,
        scores: initialScoresVec,
        perInstance: initialPerInstance,
        iteration: 0
      }
    ];

    const perInstanceAll: (number[] | ScoreVector[])[] = [initialPerInstance];

    let bestPrompt = task.initialPrompt;
    let bestScore = initialScore;
    let bestScoresVec = initialScoresVec;
    let noImprovementCount = 0;
    let iterations = 0;
    let timedOut = false;

    const optimizationHistory: Array<{
      score: number;
      promptSnippet: string;
      iteration: number;
    }> = [
      {
        score: initialScore,
        promptSnippet: task.initialPrompt.slice(0, 200),
        iteration: 0
      }
    ];

    // ── メインループ: iteration ──
    for (let iter = 1; iter <= this.maxIterations; iter++) {
      if (isDeadlineExceeded()) {
        logger.info("タイムアウトにより早期終了");
        timedOut = true;
        break;
      }

      logger.info(`=== iteration ${iter}/${this.maxIterations} ===`);

      // ── Step A: 全データで現在のベストを評価（並列） ──
      const stepAStart = Date.now();
      const fullEvalResults = await Promise.all(
        task.examples.map(async (example) => {
          try {
            const prediction = await runProgram(
              client,
              studentModel,
              bestPrompt,
              example.inputs,
              task.outputFields
            );
            const raw = await task.metric(prediction, example);
            const scalar =
              typeof raw === "number"
                ? Math.max(0, Math.min(1, raw))
                : raw && typeof raw === "object" && !Array.isArray(raw)
                  ? Object.values(raw as MetricScores).filter(Number.isFinite).length > 0
                    ? Object.values(raw as MetricScores).reduce((a, b) => a + Number(b), 0) /
                      Object.keys(raw as MetricScores).length
                    : 0
                  : 0;
            const score = Math.max(0, Math.min(1, scalar));
            const scores =
              raw && typeof raw === "object" && !Array.isArray(raw)
                ? (raw as MetricScores)
                : undefined;
            return {
              example,
              prediction,
              score,
              scores
            };
          } catch {
            return {
              example,
              prediction: Object.fromEntries(
                task.outputFields.map((f) => [f, ""])
              ),
              score: 0,
              scores: undefined
            };
          }
        })
      );
      logger.info(
        `Step A 全データ評価: ${fullEvalResults.length}件, ${(Date.now() - stepAStart) / 1000}s`
      );

      const fullEvalScore =
        fullEvalResults.reduce((s, r) => s + r.score, 0) / fullEvalResults.length;
      const withScores = fullEvalResults
        .map((r) => r.scores)
        .filter((s): s is ScoreVector => s != null && Object.keys(s).length > 0);
      const fullEvalScoresVec =
        isMultiObj && withScores.length > 0 ? avgVec(withScores) : undefined;
      logger.info(
        fullEvalScoresVec
          ? `全データ評価: スコア=${this.formatScoresForLog(fullEvalScoresVec)} n=${fullEvalResults.length}`
          : `全データ評価: スコア=${fullEvalScore.toFixed(3)} n=${fullEvalResults.length}`
      );

      // ── Step B: 反省 (Reflection) ──
      const allExamplesStr = fullEvalResults
        .slice(0, 10)
        .map((f) => {
          const inputStr = Object.entries(f.example.inputs)
            .map(([k, v]) => `  ${k}: ${v.slice(0, 200)}`)
            .join("\n");
          const predStr = Object.entries(f.prediction)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join("\n");
          const expectedStr = f.example.expectedOutputs
            ? Object.entries(f.example.expectedOutputs)
                .map(([k, v]) => `  ${k}: ${v}`)
                .join("\n")
            : "  (未指定)";
          const scoreStr =
            f.scores && Object.keys(f.scores).length > 0
              ? Object.entries(f.scores)
                  .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
                  .join(", ")
              : f.score.toFixed(2);
          return `入力:\n${inputStr}\n予測:\n${predStr}\n期待:\n${expectedStr}\nスコア: ${scoreStr}`;
        })
        .join("\n---\n");

      const reflectionPrompt =
        `AIシステムのプロンプトを分析しています。\n\n` +
        `現在のプロンプト:\n"""\n${bestPrompt}\n"""\n\n` +
        `評価結果（全例）:\n${allExamplesStr}\n\n` +
        `上記の評価結果を踏まえ、スコアが低い例はなぜ失敗しているか、スコアが高い例は何が良かったか、` +
        `プロンプトのどの部分をどう修正すれば改善されるかを3〜5文で具体的に診断してください。`;

      let reflection: string;
      try {
        reflection = await runTeacher(client, teacherModel, reflectionPrompt, 0.3);
      } catch {
        reflection =
          "反省の生成に失敗。プロンプトをより明確で具体的にすることを試みる。";
      }

      // ── Step C: インスタンスフロント頻度で親選択（多目的時は Pareto 非支配） ──
      const instanceFronts = isMultiObj
        ? buildInstanceFrontsFromVectors(
            perInstanceAll as ScoreVector[][],
            TIE_EPSILON
          )
        : buildInstanceFronts(perInstanceAll as number[][], TIE_EPSILON);
      const perProgScores = perInstanceAll.map((arr) =>
        this.isMultiObjective(arr)
          ? 0
          : (arr as number[]).reduce((a, b) => a + b, 0) / (arr.length || 1)
      );
      const parentIdx = selectParentByInstanceFronts(
        instanceFronts,
        perProgScores,
        rand
      );
      const parentPrompt = population[parentIdx]!.prompt;
      const parentEntry = population[parentIdx]!;
      const parentScoreStr =
        parentEntry.scores && Object.keys(parentEntry.scores).length > 0
          ? Object.entries(parentEntry.scores)
              .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
              .join(", ")
          : parentEntry.score.toFixed(3);

      // ── Step D: 突然変異 (Mutation) — numTrials 個の候補を生成 ──
      const historyStr = optimizationHistory
        .slice(-5)
        .map(
          (h) =>
            `  iter=${h.iteration} スコア=${h.score.toFixed(3)}: ${h.promptSnippet.slice(0, 150)}...`
        )
        .join("\n");

      const paretoForPrompt = [...population]
        .sort((a, b) => {
          const sa = sumVec((a.scores ?? { score: a.score }) as ScoreVector);
          const sb = sumVec((b.scores ?? { score: b.score }) as ScoreVector);
          return sb - sa;
        })
        .slice(0, 3);
      const topCandidates = paretoForPrompt
        .map((c) => {
          const scoreStr =
            c.scores && Object.keys(c.scores).length > 0
              ? Object.entries(c.scores)
                  .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
                  .join(", ")
              : c.score.toFixed(3);
          return `  スコア=${scoreStr}: ${c.prompt.slice(0, 150)}...`;
        })
        .join("\n");

      let iterImproved = false;

      if (!isDeadlineExceeded()) {
        const mutationPrompt =
          `あなたはAIシステムのプロンプト最適化の専門家です。\n\n` +
          `タスク情報:\n` +
          `  入力フィールド: ${task.inputFields.join(", ")}\n` +
          `  出力フィールド: ${task.outputFields.join(", ")}\n\n` +
          `親プロンプト（インスタンスフロントで選択、スコア: ${parentScoreStr}）:\n"""\n${parentPrompt}\n"""\n\n` +
          `評価の診断 (Actionable Side Information):\n${reflection}\n\n` +
          `最適化の履歴 (最近5回):\n${historyStr}\n\n` +
          `現在の Pareto Frontier の上位候補:\n${topCandidates}\n\n` +
          `以上を踏まえて、改善されたプロンプトを生成してください。\n` +
          `要件:\n` +
          `1. 診断された問題点を具体的に解決する\n` +
          `2. 過去の試みと異なるアプローチをとる\n` +
          `3. 元のタスクの意図を維持する\n` +
          `4. 明確で構造的な指示にする\n\n` +
          `改善後のプロンプトのテキストだけを返してください（説明・前置きは不要）。`;

        const trialGenStart = Date.now();
        const candidatePrompts = (
          await Promise.all(
            Array.from({ length: this.numTrials }, (_, i) =>
              runTeacher(client, teacherModel, mutationPrompt, 0.8)
                .then((prompt) => (prompt && prompt.length >= 10 ? prompt : null))
                .catch((err) => {
                  logger.info(
                    `trial ${i + 1}: Teacher 呼び出し失敗 — ${err instanceof Error ? err.message : String(err)}`
                  );
                  return null;
                })
            )
          )
        ).filter((p): p is string => p != null);
        logger.info(
          `候補生成: ${this.numTrials}件, ${(Date.now() - trialGenStart) / 1000}s`
        );

        const candidateEvalStart = Date.now();
        const evalResults = await Promise.all(
          candidatePrompts.map((prompt) =>
            evaluatePrompt(client, studentModel, prompt, task)
          )
        );
        logger.info(
          `候補評価: ${evalResults.length}候補×${task.examples.length}例, ${(Date.now() - candidateEvalStart) / 1000}s`
        );

        for (let i = 0; i < evalResults.length; i++) {
          const res = evalResults[i]!;
          const prompt = candidatePrompts[i]!;
          if (!res || !prompt) continue;

          const perInstance = this.getPerInstance(
            res.predictions.map((p) => ({ score: p.score, scores: p.scores }))
          );
          const scoresVec =
            res.scoresPerExample && res.scoresPerExample.length > 0
              ? avgVec(res.scoresPerExample)
              : undefined;
          const score = res.score;

          optimizationHistory.push({
            score,
            promptSnippet: prompt.slice(0, 200),
            iteration: iter
          });

          const accepted = isMultiObj
            ? scoresVec && !isDominatedByAny(scoresVec, population.map((p) => p.scores ?? { score: p.score }), TIE_EPSILON)
            : score > bestScore;

          if (accepted) {
            population.push({
              prompt,
              score,
              scores: scoresVec,
              perInstance,
              reflection,
              iteration: iter
            });
            perInstanceAll.push(perInstance);

            if (isMultiObj && scoresVec) {
              bestPrompt = prompt;
              bestScoresVec = scoresVec;
              bestScore = metricKeys[0] ? Number(scoresVec[metricKeys[0]]) : score;
            } else if (!isMultiObj && score > bestScore) {
              bestScore = score;
              bestPrompt = prompt;
            }
            noImprovementCount = 0;
            iterImproved = true;
            logger.info(
              `新ベスト! ${isMultiObj && scoresVec ? this.formatScoresForLog(scoresVec) : `スコア=${bestScore.toFixed(3)}`}`
            );
          }
        }

        iterations = iter;
        const maxTrialScore =
          evalResults.length > 0
            ? Math.max(...evalResults.map((r) => r.score))
            : 0;
        if (evalResults.length > 0) {
          logger.progress({
            step: "trial",
            iteration: iter,
            trial: candidatePrompts.length,
            currentScore: maxTrialScore,
            bestScore,
            bestScores: bestScoresVec,
            message:
              isMultiObj && bestScoresVec
                ? `並列評価 ${candidatePrompts.length}件 ベスト=${this.formatScoresForLog(bestScoresVec)}`
                : `並列評価 ${candidatePrompts.length}件 ベスト=${bestScore.toFixed(3)}`
          });
        }

        // Pareto Frontier を最大10件に制限
        if (population.length > 10) {
          const withIdx = population.map((p, i) => ({
            entry: p,
            perInst: perInstanceAll[i]!
          }));
          const items = withIdx.map((x, j) => ({
            idx: j,
            scores: (x.entry.scores ?? { score: x.entry.score }) as ScoreVector
          }));
          const paretoIdx = buildParetoFront(items, TIE_EPSILON);
          const dominated = withIdx
            .map((x, i) => ({ x, i }))
            .filter((_, i) => !paretoIdx.includes(i));
          dominated.sort((a, b) => {
            const sa = sumVec((a.x.entry.scores ?? { score: a.x.entry.score }) as ScoreVector);
            const sb = sumVec((b.x.entry.scores ?? { score: b.x.entry.score }) as ScoreVector);
            return sa - sb;
          });
          const toRemove = new Set(
            dominated.slice(0, population.length - 10).map((d) => d.i)
          );
          const kept = withIdx.filter((_, i) => !toRemove.has(i));
          population.length = 0;
          population.push(...kept.map((x) => x.entry));
          perInstanceAll.length = 0;
          perInstanceAll.push(...kept.map((x) => x.perInst));
        }
      }

      // ── Step E: Merge ──
      if (population.length >= 2 && !isDeadlineExceeded()) {
        const merged = await this.tryMerge(
          client,
          teacherModel,
          studentModel,
          population,
          task,
          logger
        );
        const mergeAccepted =
          merged != null &&
          (isMultiObj && merged.scores
            ? !isDominatedByAny(
                merged.scores,
                population.map((p) => p.scores ?? { score: p.score }),
                TIE_EPSILON
              )
            : merged.score > bestScore);
        if (mergeAccepted && merged != null) {
          bestPrompt = merged.prompt;
          bestScoresVec = merged.scores;
          bestScore = merged.score;
          noImprovementCount = 0;
          iterImproved = true;
          population.push(merged);
          perInstanceAll.push(merged.perInstance);
          logger.info(
            `Merge: 新ベスト! ${isMultiObj && merged.scores ? this.formatScoresForLog(merged.scores) : `スコア=${merged.score.toFixed(3)}`}`
          );
        }
      }

      // ── 早期終了判定 ──
      if (!iterImproved) {
        noImprovementCount++;
        logger.info(
          `iteration ${iter}: 改善なし` +
            ` (${noImprovementCount}/${this.earlyStoppingTrials} 回連続)`
        );
        if (noImprovementCount >= this.earlyStoppingTrials) {
          logger.info(
            `早期終了: ${iter} イテレーション後に停止` +
              ` (${this.earlyStoppingTrials} 回連続で改善なし)`
          );
          break;
        }
      } else {
        noImprovementCount = 0;
      }
    }

    // ── 多目的時: Pareto frontier を構築し辞書式でベストを選択 ──
    let paretoFront: Array<{ prompt: string; scores: MetricScores }> | undefined;
    if (population.some((p) => p.scores && Object.keys(p.scores).length > 0)) {
      const items = population.map((p, idx) => ({
        idx,
        scores: (p.scores ?? { score: p.score }) as ScoreVector
      }));
      const paretoIdx = buildParetoFront(items, TIE_EPSILON);
      paretoFront = paretoIdx.map((idx) => ({
        prompt: population[idx]!.prompt,
        scores: (population[idx]!.scores ?? { score: population[idx]!.score }) as MetricScores
      }));

      const sorted = [...paretoIdx].sort((a, b) => {
        const sa = sumVec((population[a]!.scores ?? { score: population[a]!.score }) as ScoreVector);
        const sb = sumVec((population[b]!.scores ?? { score: population[b]!.score }) as ScoreVector);
        return sb - sa;
      });
      const bestParetoIdx = sorted[0];
      if (bestParetoIdx != null) {
        bestPrompt = population[bestParetoIdx]!.prompt;
        const s = population[bestParetoIdx]!.scores ?? { score: population[bestParetoIdx]!.score };
        bestScore = metricKeys[0] ? Number(s[metricKeys[0]]) : population[bestParetoIdx]!.score;
      }
    }

    logger.info(
      (isMultiObj && bestScoresVec
        ? `完了 iterations=${iterations} bestScore=${this.formatScoresForLog(bestScoresVec)}`
        : `完了 iterations=${iterations} bestScore=${bestScore.toFixed(3)}`) +
        ` populationSize=${population.length} timedOut=${timedOut}`
    );

    return {
      optimizedPrompt: bestPrompt,
      bestScore,
      initialScore,
      iterations,
      timedOut,
      log: logger.getLogs(),
      paretoFront
    };
  }

  private async tryMerge(
    client: GoogleGenAI,
    teacherModel: string,
    studentModel: string,
    population: PopulationEntry[],
    task: OptimizationTask,
    logger: OptimizationLogger
  ): Promise<PopulationEntry | null> {
    if (population.length < 2) return null;

    const mergeKeys =
      population[0]?.scores && Object.keys(population[0].scores).length > 0
        ? this.getMetricKeys(population[0].scores)
        : ["score"];
    const items = population.map((p, i) => ({
      idx: i,
      scores: (p.scores ?? { score: p.score }) as ScoreVector
    }));
    const paretoIdx = buildParetoFront(items, TIE_EPSILON);
    const sorted = [...paretoIdx].sort((a, b) => {
      const sa = sumVec((population[a]!.scores ?? { score: population[a]!.score }) as ScoreVector);
      const sb = sumVec((population[b]!.scores ?? { score: population[b]!.score }) as ScoreVector);
      return sb - sa;
    });
    if (sorted.length < 2) return null;

    const promptA = population[sorted[0]!]!;
    const promptB = population[sorted[1]!]!;

    if (promptA.prompt === promptB.prompt) return null;

    const scoreStrA =
      promptA.scores && Object.keys(promptA.scores).length > 0
        ? Object.entries(promptA.scores)
            .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
            .join(", ")
        : promptA.score.toFixed(3);
    const scoreStrB =
      promptB.scores && Object.keys(promptB.scores).length > 0
        ? Object.entries(promptB.scores)
            .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
            .join(", ")
        : promptB.score.toFixed(3);

    const mergePrompt =
      `2つのAIプロンプトをマージして、両方の長所を持つ新しいプロンプトを作成してください。\n\n` +
      `プロンプト A (スコア: ${scoreStrA}):\n"""\n${promptA.prompt}\n"""\n\n` +
      `プロンプト B (スコア: ${scoreStrB}):\n"""\n${promptB.prompt}\n"""\n\n` +
      `マージ後のプロンプトの要件:\n` +
      `- 両方の強みを組み合わせ、弱点を排除する\n` +
      `- より汎化されたプロンプトにする\n` +
      `- 元のタスクの意図を維持する\n\n` +
      `マージ後のプロンプトのテキストだけを返してください（説明不要）。`;

    try {
      const merged = await runTeacher(client, teacherModel, mergePrompt, 0.5);
      if (!merged || merged.length < 10) return null;

      const evalResult = await evaluatePrompt(client, studentModel, merged, task);
      const perInstance = this.getPerInstance(
        evalResult.predictions.map((p) => ({ score: p.score, scores: p.scores }))
      );
      const scoresVec =
        evalResult.scoresPerExample && evalResult.scoresPerExample.length > 0
          ? avgVec(evalResult.scoresPerExample)
          : undefined;

      logger.info(
        `Merge: ${scoresVec && Object.keys(scoresVec).length > 0 ? this.formatScoresForLog(scoresVec) : evalResult.score.toFixed(3)}`
      );

      return {
        prompt: merged,
        score: evalResult.score,
        scores: scoresVec,
        perInstance,
        iteration: -1
      };
    } catch {
      return null;
    }
  }
}
