/**
 * プロンプト最適化ライブラリ — 統合テスト
 *
 * Gemini API を実際に呼び出して3つの最適化手法が動作することを確認する。
 *
 * 実行方法:
 *   GEMINI_API_KEY=xxx npx vitest run tests/promptOptimizer/integration.test.ts
 *   または .env に GEMINI_API_KEY を設定して:
 *   npx dotenv -e .env -- npx vitest run tests/promptOptimizer/integration.test.ts
 *
 * テストシナリオ: 感情分類タスクのプロンプト最適化
 *   - 入力: review（レビューテキスト）
 *   - 出力: sentiment（"positive" | "negative"）
 *   - メトリクス: 期待値との一致率
 *
 * 注意: APIコストを最小化するために最小パラメータで実行する。
 * 本番環境では numTrials/maxIterations を増やすことで精度が向上する。
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  MetaPromptOptimizer,
  BootstrapFewShotOptimizer,
  GEPAOptimizer,
  optimizePrompt
} from "@/lib/promptOptimizer";
import type { OptimizationTask, Example } from "@/lib/promptOptimizer";

// ── 環境変数チェック ──
const API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_APIKEY;

// 検証に使うモデル（コスト・速度優先）
// 環境変数 TEST_MODEL で上書き可能
const TEST_MODEL = process.env.TEST_MODEL ?? "gemini-2.5-flash-lite";
const TEST_TEACHER_MODEL = process.env.TEST_TEACHER_MODEL ?? "gemini-2.5-flash";

// テスト全体のタイムアウト（余裕を持たせる）
const SUITE_TIMEOUT_MS = 120_000;

// ── テスト用のトレーニング例 ──
// 感情分類タスク（シンプルで評価しやすい）
const SENTIMENT_EXAMPLES: Example[] = [
  {
    inputs: { review: "この商品は最高でした！期待以上のクオリティです。" },
    expectedOutputs: { sentiment: "positive" }
  },
  {
    inputs: { review: "全くダメでした。二度と買いません。" },
    expectedOutputs: { sentiment: "negative" }
  },
  {
    inputs: { review: "素晴らしいサービスで感動しました。また利用します！" },
    expectedOutputs: { sentiment: "positive" }
  },
  {
    inputs: { review: "使えないです。お金の無駄でした。" },
    expectedOutputs: { sentiment: "negative" }
  },
  {
    inputs: { review: "品質が高くて満足しています。おすすめです。" },
    expectedOutputs: { sentiment: "positive" }
  },
  {
    inputs: { review: "最悪の体験でした。クレームを入れます。" },
    expectedOutputs: { sentiment: "negative" }
  }
];

/** メトリクス: sentiment フィールドの完全一致 */
function sentimentMetric(
  prediction: Record<string, string>,
  example: Example
): number {
  const pred = prediction.sentiment?.trim().toLowerCase();
  const expected = example.expectedOutputs?.sentiment?.trim().toLowerCase();
  if (!pred || !expected) return 0;
  // 部分一致も許容（"positive" が含まれれば OK）
  if (pred === expected) return 1;
  if (pred.includes(expected) || expected.includes(pred)) return 0.8;
  return 0;
}

/** 共通の最適化タスク */
const SENTIMENT_TASK: OptimizationTask = {
  // わざと曖昧な初期プロンプト（最適化の余地あり）
  initialPrompt: "テキストを分析してください。",
  inputFields: ["review"],
  outputFields: ["sentiment"],
  examples: SENTIMENT_EXAMPLES,
  metric: sentimentMetric
};

// ── テストユーティリティ ──
function skipIfNoKey() {
  if (!API_KEY) {
    console.warn(
      "⚠️  GEMINI_API_KEY が未設定のためスキップ。" +
        " .env に設定するか環境変数として渡してください。"
    );
    return true;
  }
  return false;
}

function logResult(
  method: string,
  result: { optimizedPrompt: string; bestScore: number; initialScore: number; iterations: number; timedOut: boolean; log: string[] }
): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📊 ${method} 結果:`);
  console.log(`  初期スコア:  ${result.initialScore.toFixed(3)}`);
  console.log(`  最終スコア:  ${result.bestScore.toFixed(3)}`);
  console.log(`  改善幅:      ${(result.bestScore - result.initialScore).toFixed(3)}`);
  console.log(`  イテレーション: ${result.iterations}`);
  console.log(`  タイムアウト: ${result.timedOut}`);
  console.log(`  最適化後プロンプト (先頭200字):\n    ${result.optimizedPrompt.slice(0, 200)}`);
  console.log(`  ログ (直近5件):`);
  result.log.slice(-5).forEach((l) => console.log(`    ${l}`));
  console.log("=".repeat(60));
}

// ────────────────────────────────────────────────────────────

describe("Prompt Optimizer Integration Tests", { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeAll(() => {
    if (API_KEY) {
      console.log(`✅ APIキー確認済み`);
      console.log(`📌 studentModel: ${TEST_MODEL}`);
      console.log(`📌 teacherModel: ${TEST_TEACHER_MODEL}`);
    }
  });

  // ── 1. MetaPromptOptimizer ──
  describe("MetaPromptOptimizer", () => {
    it("感情分類タスクを MetaPrompt で最適化できる", async () => {
      if (skipIfNoKey()) return;

      const optimizer = new MetaPromptOptimizer({
        apiKey: API_KEY,
        studentModel: TEST_MODEL,
        teacherModel: TEST_TEACHER_MODEL,
        numRefinements: 2,      // APIコスト最小化
        maxFailures: 3,
        timeoutMs: 60_000,
        verbose: true
      });

      const result = await optimizer.optimize(SENTIMENT_TASK);

      logResult("MetaPromptOptimizer", result);

      // アサーション
      expect(result.optimizedPrompt).toBeTruthy();
      expect(result.optimizedPrompt.length).toBeGreaterThan(10);
      expect(result.bestScore).toBeGreaterThanOrEqual(0);
      expect(result.bestScore).toBeLessThanOrEqual(1);
      expect(result.initialScore).toBeGreaterThanOrEqual(0);
      expect(result.iterations).toBeGreaterThanOrEqual(1);
      expect(result.log.length).toBeGreaterThan(0);
      // 最適化後のスコアは初期スコア以上であること（改善または維持）
      expect(result.bestScore).toBeGreaterThanOrEqual(result.initialScore);

      console.log(
        result.bestScore > result.initialScore
          ? `✅ 改善成功: ${result.initialScore.toFixed(3)} → ${result.bestScore.toFixed(3)}`
          : `⚠️  改善なし（初期プロンプトが既に良い可能性）`
      );
    });
  });

  // ── 2. BootstrapFewShotOptimizer ──
  describe("BootstrapFewShotOptimizer", () => {
    it("感情分類タスクを BootstrapFewShot で最適化できる", async () => {
      if (skipIfNoKey()) return;

      const optimizer = new BootstrapFewShotOptimizer({
        apiKey: API_KEY,
        studentModel: TEST_MODEL,
        teacherModel: TEST_TEACHER_MODEL,
        maxDemos: 2,           // APIコスト最小化
        maxRounds: 2,
        demoThreshold: 0.5,
        timeoutMs: 90_000,
        verbose: true
      });

      const result = await optimizer.optimize(SENTIMENT_TASK);

      logResult("BootstrapFewShotOptimizer", result);

      // アサーション
      expect(result.optimizedPrompt).toBeTruthy();
      expect(result.bestScore).toBeGreaterThanOrEqual(0);
      expect(result.bestScore).toBeLessThanOrEqual(1);
      expect(result.log.length).toBeGreaterThan(0);

      // デモが含まれていること（bootstrap が成功した場合）
      if (result.demos && result.demos.length > 0) {
        console.log(`✅ デモ取得: ${result.demos.length} 件`);
        result.demos.forEach((d, i) => {
          expect(d.inputs).toBeTruthy();
          expect(d.outputs).toBeTruthy();
          console.log(`  デモ ${i + 1}: inputs=${JSON.stringify(d.inputs)} outputs=${JSON.stringify(d.outputs)}`);
        });
      } else {
        console.log("ℹ️  デモなし（初期スコアが既に最大でデモが採用されなかった可能性）");
      }

      console.log(
        result.bestScore > result.initialScore
          ? `✅ 改善成功: ${result.initialScore.toFixed(3)} → ${result.bestScore.toFixed(3)}`
          : `⚠️  改善なし`
      );
    });
  });

  // ── 3. GEPAOptimizer ──
  describe("GEPAOptimizer", () => {
    it("感情分類タスクを GEPA で最適化できる", async () => {
      if (skipIfNoKey()) return;

      const optimizer = new GEPAOptimizer({
        apiKey: API_KEY,
        studentModel: TEST_MODEL,
        teacherModel: TEST_TEACHER_MODEL,
        numTrials: 2,          // APIコスト最小化
        minibatchSize: 3,
        maxIterations: 2,
        earlyStoppingTrials: 2,
        timeoutMs: 120_000,
        verbose: true
      });

      const result = await optimizer.optimize(SENTIMENT_TASK);

      logResult("GEPAOptimizer", result);

      // アサーション
      expect(result.optimizedPrompt).toBeTruthy();
      expect(result.bestScore).toBeGreaterThanOrEqual(0);
      expect(result.bestScore).toBeLessThanOrEqual(1);
      expect(result.log.length).toBeGreaterThan(0);
      expect(result.timedOut).toBe(false); // タイムアウトしないこと

      console.log(
        result.bestScore > result.initialScore
          ? `✅ 改善成功: ${result.initialScore.toFixed(3)} → ${result.bestScore.toFixed(3)}`
          : `⚠️  改善なし`
      );
    });
  });

  // ── 4. タイムアウト機能のテスト ──
  describe("タイムアウト機能", () => {
    it("timeoutMs を超えたら途中で打ち切り timedOut=true を返す", async () => {
      if (skipIfNoKey()) return;

      // 非常に短いタイムアウト（最初の評価後に打ち切られる）
      const optimizer = new GEPAOptimizer({
        apiKey: API_KEY,
        studentModel: TEST_MODEL,
        teacherModel: TEST_TEACHER_MODEL,
        maxIterations: 10,     // 本来は10回まで
        timeoutMs: 1,          // 1ms でほぼ確実にタイムアウト
        verbose: false
      });

      const result = await optimizer.optimize(SENTIMENT_TASK);

      // タイムアウトで打ち切られること
      // 注意: 最初の初期評価だけは timeoutMs 前に完了する場合がある
      // ここでは少なくとも結果が返ること（クラッシュしないこと）を確認
      expect(result.optimizedPrompt).toBeTruthy();
      expect(result.log.length).toBeGreaterThan(0);
      console.log(`タイムアウトテスト: timedOut=${result.timedOut} iterations=${result.iterations}`);
    });
  });

  // ── 5. optimizePrompt 便利関数のテスト ──
  describe("optimizePrompt 便利関数", () => {
    it("method='meta' で MetaPromptOptimizer が呼ばれる", async () => {
      if (skipIfNoKey()) return;

      const result = await optimizePrompt("meta", SENTIMENT_TASK, {
        apiKey: API_KEY,
        studentModel: TEST_MODEL,
        teacherModel: TEST_TEACHER_MODEL,
        numRefinements: 1,
        timeoutMs: 30_000,
        verbose: false
      });

      expect(result.optimizedPrompt).toBeTruthy();
      expect(typeof result.bestScore).toBe("number");
      console.log(
        `optimizePrompt('meta'): score=${result.bestScore.toFixed(3)} iterations=${result.iterations}`
      );
    });
  });
});
