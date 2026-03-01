import { describe, expect, it } from "vitest";
import {
  calculateTargetGepaMetric,
  scoreTargetOutputFormat
} from "@/lib/application/promptOptimization/gepaMetrics";

describe("calculateTargetGepaMetric", () => {
  it("同じ出力品質なら baseline より改善幅が大きいほど高スコアになる", () => {
    const output =
      "候補者はWebアプリ開発を主導し、API改善で応答時間を35%短縮。要件定義から運用改善まで一貫して担当し、障害件数を月5件から2件に削減。";

    const weak = calculateTargetGepaMetric(3, output, {
      userInput: "input",
      passThreshold: 4,
      baselineScore: 2,
      domain: "resume_summary"
    });
    const improved = calculateTargetGepaMetric(4, output, {
      userInput: "input",
      passThreshold: 4,
      baselineScore: 2,
      domain: "resume_summary"
    });

    expect(improved).toBeGreaterThan(weak);
  });

  it("self_pr の形式適合スコアは適正文字数のほうが高い", () => {
    const shortText = "短い自己PRです。";
    const longText =
      "私は業務改善とプロジェクト推進を得意とし、前職では運用フローを再設計して月次処理時間を30%削減しました。" +
      "また、要件定義から実装、効果測定まで一貫して担当し、関係部署との調整を通じてリリース品質を継続的に改善してきました。" +
      "数値で成果を示すことを重視し、チーム全体の再現性ある改善活動を推進できます。";

    const shortScore = scoreTargetOutputFormat(shortText, "self_pr");
    const properScore = scoreTargetOutputFormat(longText, "self_pr");

    expect(properScore).toBeGreaterThan(shortScore);
  });

  it("resume_detail は構造と数値を含む出力を高く評価する", () => {
    const structured = [
      "会社: A社",
      "期間: 2021-2024",
      "職務内容: バックエンド開発",
      "実績・成果: API応答時間を40%改善、障害対応工数を月20時間削減"
    ].join("\n");
    const unstructured = "バックエンドを担当して色々改善しました。";

    const structuredScore = scoreTargetOutputFormat(structured, "resume_detail");
    const unstructuredScore = scoreTargetOutputFormat(unstructured, "resume_detail");

    expect(structuredScore).toBeGreaterThan(unstructuredScore);
  });
});
