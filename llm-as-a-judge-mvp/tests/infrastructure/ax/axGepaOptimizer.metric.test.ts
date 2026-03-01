import { describe, expect, it } from "vitest";
import { calculateJudgeGepaMetric } from "@/lib/application/promptOptimization/gepaMetrics";

describe("calculateJudgeGepaMetric", () => {
  const rubricKeywords = ["実績", "具体性", "読みやすさ"];

  it("score一致・合否一致・理由品質が高い場合は高スコアになる", () => {
    const score = calculateJudgeGepaMetric(
      {
        score: 4,
        reason: "実績と具体性が十分で、読みやすさも高い要約です。"
      },
      {
        humanScore: 4,
        passThreshold: 4,
        humanComment: "具体性が高く読みやすい"
      },
      rubricKeywords
    );

    expect(score).toBeGreaterThan(0.9);
  });

  it("合否が不一致だと減点される", () => {
    const matched = calculateJudgeGepaMetric(
      {
        score: 4,
        reason: "実績と具体性が十分で、読みやすさも高い要約です。"
      },
      {
        humanScore: 4,
        passThreshold: 4
      },
      rubricKeywords
    );
    const mismatched = calculateJudgeGepaMetric(
      {
        score: 3,
        reason: "実績と具体性が十分で、読みやすさも高い要約です。"
      },
      {
        humanScore: 4,
        passThreshold: 4
      },
      rubricKeywords
    );

    expect(mismatched).toBeLessThan(matched);
  });

  it("理由テキストが空の場合は理由品質分が乗らない", () => {
    const withReason = calculateJudgeGepaMetric(
      {
        score: 4,
        reason: "実績と具体性が十分で、読みやすさも高い要約です。"
      },
      {
        humanScore: 4,
        passThreshold: 4
      },
      rubricKeywords
    );
    const withoutReason = calculateJudgeGepaMetric(
      {
        score: 4,
        reason: ""
      },
      {
        humanScore: 4,
        passThreshold: 4
      },
      rubricKeywords
    );

    expect(withoutReason).toBeLessThan(withReason);
  });
});
