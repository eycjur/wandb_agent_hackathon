import type { DomainId } from "@/lib/config/domainPromptLoader";

export type JudgeGepaMetricExample = {
  humanScore: number;
  passThreshold: number;
  humanComment?: string;
};

export type TargetGepaMetricExample = {
  userInput: string;
  passThreshold: number;
  baselineScore: number;
  domain: DomainId;
};

const SCORE_MAX = 5;

const JUDGE_METRIC_WEIGHTS = {
  scoreAgreement: 0.6,
  passAgreement: 0.25,
  reasonQuality: 0.15
} as const;

const TARGET_METRIC_WEIGHTS = {
  absoluteQuality: 0.5,
  improvementDelta: 0.25,
  passReached: 0.15,
  formatScore: 0.1
} as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function toScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.round(n), 0), SCORE_MAX);
}

function extractKeywordsFromTexts(texts: string[]): string[] {
  const keywords = new Set<string>();
  for (const text of texts) {
    const matches = text.match(/[A-Za-z0-9]{2,}|[ぁ-んァ-ヶー一-龠]{2,}/g) ?? [];
    for (const match of matches) {
      keywords.add(match.toLowerCase());
    }
  }
  return [...keywords];
}

function computeKeywordCoverage(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 0.5;
  const normalized = text.toLowerCase();
  let hit = 0;
  for (const keyword of keywords) {
    if (normalized.includes(keyword)) hit += 1;
  }
  return clamp01(hit / keywords.length);
}

function computeReasonLengthScore(reason: string): number {
  const len = reason.trim().length;
  if (len === 0) return 0;
  if (len < 20) return clamp01(len / 20);
  if (len <= 220) return 1;
  // 過剰に長い理由は読みやすさの観点で減点する
  return clamp01(1 - (len - 220) / 280);
}

function computeReasonQualityScore(
  reason: string,
  rubricKeywords: string[],
  humanComment?: string
): number {
  if (typeof reason !== "string" || reason.trim() === "") return 0;
  const lengthScore = computeReasonLengthScore(reason);
  const rubricCoverage = computeKeywordCoverage(reason, rubricKeywords);
  const commentKeywords = humanComment
    ? extractKeywordsFromTexts([humanComment]).slice(0, 12)
    : [];
  const feedbackCoverage = computeKeywordCoverage(reason, commentKeywords);
  return clamp01(lengthScore * 0.45 + rubricCoverage * 0.35 + feedbackCoverage * 0.2);
}

export function buildRubricKeywords(rubricItems: string[]): string[] {
  return extractKeywordsFromTexts(rubricItems).slice(0, 24);
}

/**
 * Judge GEPA 用の複合メトリクス
 * - score 一致度
 * - pass/fail 一致度
 * - reason 品質（長さ・ルーブリック語彙・人間コメント整合）
 */
export function calculateJudgeGepaMetric(
  prediction: { score?: unknown; reason?: unknown },
  example: JudgeGepaMetricExample,
  rubricKeywords: string[]
): number {
  const breakdown = calculateJudgeGepaMetricBreakdown(
    prediction,
    example,
    rubricKeywords
  );
  return clamp01(
    breakdown.scoreAgreement * JUDGE_METRIC_WEIGHTS.scoreAgreement +
      breakdown.passAgreement * JUDGE_METRIC_WEIGHTS.passAgreement +
      breakdown.reasonQuality * JUDGE_METRIC_WEIGHTS.reasonQuality
  );
}

export function calculateJudgeGepaMetricBreakdown(
  prediction: { score?: unknown; reason?: unknown },
  example: JudgeGepaMetricExample,
  rubricKeywords: string[]
): {
  scoreAgreement: number;
  passAgreement: number;
  reasonQuality: number;
  reasonLength: number;
} {
  const predictedScore = toScore(prediction.score);
  const humanScore = toScore(example.humanScore);
  const passThreshold = Math.min(Math.max(Number(example.passThreshold), 0), SCORE_MAX);
  const scoreAgreement = clamp01(1 - Math.abs(predictedScore - humanScore) / SCORE_MAX);
  const passAgreement =
    (predictedScore >= passThreshold) === (humanScore >= passThreshold) ? 1 : 0;
  const reason = typeof prediction.reason === "string" ? prediction.reason : "";
  const reasonQuality = computeReasonQualityScore(reason, rubricKeywords, example.humanComment);
  const reasonLength = computeReasonLengthScore(reason);
  return {
    scoreAgreement,
    passAgreement,
    reasonQuality,
    reasonLength
  };
}

function countSentences(text: string): number {
  return text
    .split(/[。.!?！？]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

/**
 * ドメインごとの最低限の出力品質を簡易に評価する
 * （高ウェイトにはせず、破綻した出力を抑制する目的）
 */
export function scoreTargetOutputFormat(output: string, domain: DomainId): number {
  const text = output.trim();
  if (text.length === 0) return 0;
  const hasNumber = /\d/.test(text) ? 1 : 0;

  if (domain === "self_pr") {
    const len = text.length;
    const lengthScore =
      len >= 200 && len <= 400
        ? 1
        : len < 200
          ? clamp01((len - 80) / 120)
          : clamp01(1 - (len - 400) / 320);
    const sentenceScore = clamp01(countSentences(text) / 3);
    return clamp01(lengthScore * 0.8 + sentenceScore * 0.2);
  }

  if (domain === "resume_summary") {
    const sentenceCount = countSentences(text);
    const sentenceScore =
      sentenceCount >= 3 && sentenceCount <= 6 ? 1 : sentenceCount === 2 || sentenceCount === 7 ? 0.7 : 0.35;
    const lengthScore = text.length >= 90 && text.length <= 700 ? 1 : 0.6;
    return clamp01(sentenceScore * 0.65 + lengthScore * 0.2 + hasNumber * 0.15);
  }

  // resume_detail
  const lineCount = text.split("\n").filter((line) => line.trim() !== "").length;
  const structureSignal = /(会社|期間|職務|実績|成果)/.test(text) ? 1 : 0;
  const lineScore = lineCount >= 6 ? 1 : clamp01(lineCount / 6);
  const lengthScore = text.length >= 220 ? 1 : clamp01(text.length / 220);
  return clamp01(lineScore * 0.4 + structureSignal * 0.35 + hasNumber * 0.15 + lengthScore * 0.1);
}

export function calculateTargetGepaMetric(
  predictedScore: unknown,
  generatedOutput: string,
  example: TargetGepaMetricExample
): number {
  const breakdown = calculateTargetGepaMetricBreakdown(
    predictedScore,
    generatedOutput,
    example
  );
  return clamp01(
    breakdown.absoluteQuality * TARGET_METRIC_WEIGHTS.absoluteQuality +
      breakdown.improvementDelta * TARGET_METRIC_WEIGHTS.improvementDelta +
      breakdown.passReached * TARGET_METRIC_WEIGHTS.passReached +
      breakdown.formatScore * TARGET_METRIC_WEIGHTS.formatScore
  );
}

export function calculateTargetGepaMetricBreakdown(
  predictedScore: unknown,
  generatedOutput: string,
  example: TargetGepaMetricExample
): {
  absoluteQuality: number;
  improvementDelta: number;
  passReached: number;
  formatScore: number;
  /** スカラー化済み（absoluteQuality + improvementDelta + passReached の加重平均） */
  score: number;
} {
  const score = toScore(predictedScore);
  const passThreshold = Math.min(Math.max(Number(example.passThreshold), 0), SCORE_MAX);
  const baselineScore = toScore(example.baselineScore);

  const absoluteQuality = clamp01(score / Math.max(passThreshold, 1));
  const improvementDelta = clamp01(
    (score - baselineScore) / Math.max(SCORE_MAX - baselineScore, 1)
  );
  const passReached = score >= passThreshold ? 1 : 0;
  const formatScore = scoreTargetOutputFormat(generatedOutput, example.domain);

  const scalarScore = clamp01(
    absoluteQuality * TARGET_METRIC_WEIGHTS.absoluteQuality +
      improvementDelta * TARGET_METRIC_WEIGHTS.improvementDelta +
      passReached * TARGET_METRIC_WEIGHTS.passReached
  );

  return {
    absoluteQuality,
    improvementDelta,
    passReached,
    formatScore,
    score: scalarScore
  };
}
