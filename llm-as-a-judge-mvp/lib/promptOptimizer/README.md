# Prompt Optimizer Library

汎用プロンプト最適化ライブラリ。3つの最適化手法を提供し、Judge プロンプト・Target プロンプトの改善に利用されます。

## 概要

| 手法 | クラス | 参考 | 特徴 |
|------|--------|------|------|
| **Meta** | `MetaPromptOptimizer` | OPRO (Yang et al., ICLR 2024) | イテレーティブな改善。シンプルで少ない試行で効果あり |
| **Few-shot** | `BootstrapFewShotOptimizer` | DSPy (Khattab et al., 2023) | Teacher で成功デモを収集し、Few-shot プロンプトを構築 |
| **GEPA** | `GEPAOptimizer` | GEPA (Gallotta et al., ICLR 2026) | 反省的進化・Pareto frontier・インスタンスフロント頻度 |

---

## ディレクトリ構成

```
lib/promptOptimizer/
├── README.md              # 本ドキュメント
├── GEPA.md                # GEPA 詳細仕様（iteration/trial、Pareto、並列化）
├── index.ts               # エントリポイント・型エクスポート・optimizePrompt 便利関数
├── types.ts               # Example, OptimizationTask, OptimizationResult など
├── MetaPromptOptimizer.ts # OPRO ベースのメタプロンプト最適化
├── BootstrapFewShotOptimizer.ts # DSPy 流 Bootstrap Few-Shot
├── GEPAOptimizer.ts       # 反省的プロンプト進化
├── runner.ts              # runProgram, evaluatePrompt, runTeacher（Gemini 呼び出し）
├── concurrencyLimiter.ts   # LLM 同時呼び出し数制限・ログ
├── logLevel.ts             # ログレベル管理（GEPA_LOG_LEVEL）
├── paretoUtils.ts         # Pareto frontier・インスタンスフロント（GEPA 用）
├── logger.ts              # OptimizationLogger
└── timeout.ts             # タイムアウト・打ち切り
```

---

## 最適化手法の比較

### MetaPromptOptimizer（Meta）

- **アルゴリズム**: 失敗例を Teacher に渡し、改善プロンプトを提案。評価してベストより良ければ採用。
- **パラメータ**: `numRefinements`（改善ラウンド数）, `maxFailures`（失敗例の最大件数）
- **用途**: 軽量で素早い改善。初期プロトタイプや少データ向け。

### BootstrapFewShotOptimizer（Few-shot）

- **アルゴリズム**:
  1. **Bootstrap**: Teacher が各例を解き、閾値以上の例を成功デモとして収集
  2. **選択**: スコア降順 + ランダムサンプルでデモセットを構成
  3. **コンパイル**: デモを埋め込んだ Few-shot プロンプトを生成・評価
- **パラメータ**: `maxDemos`, `maxRounds`, `demoThreshold`, `compileTimeoutMs`
- **用途**: 人手でデモを書かず、モデル自身の成功例で Few-shot を構築。

### GEPAOptimizer（GEPA）

- **アルゴリズム**: 反省（Reflection）→ 突然変異（Mutation）→ Merge のループ。Pareto frontier で候補を保持し、インスタンスフロント頻度で親を選択。
- **パラメータ**: `numTrials`, `maxIterations`, `earlyStoppingTrials`
- **詳細**: [GEPA.md](./GEPA.md) を参照
- **用途**: 多目的最適化・高品質なプロンプト進化。コストは高め。

---

## ループ階層とイテレーションの流れ

### MetaPromptOptimizer

**ループ階層**: `refinement`（1 ～ numRefinements）の単一ループ

```
初期化
├── Step 1: 初期プロンプトを全 examples で評価
└── refinement ループ（1 ～ numRefinements）
    ├── 失敗例収集（スコア < 0.5 の例を最大 maxFailures 件）
    ├── Teacher に失敗例 + 履歴を渡し、改善プロンプトを生成
    ├── 改善プロンプトを全 examples で評価
    └── ベストより良ければ採用、そうでなければスキップ
```

**1 refinement の流れ**: 失敗例収集 → Teacher 呼び出し（1回）→ 評価（全 example 並列）→ 採用判定

---

### BootstrapFewShotOptimizer

**ループ階層**: `Phase 0` → `Phase 1`（1回）→ `round`（1 ～ maxRounds）

```
Phase 0: 初期評価
└── デモなしで初期プロンプトを全 examples で評価（ベースライン）

Phase 1: Bootstrap（1回のみ、並列）
└── 各 example を Teacher に解かせる（並列）
    └── スコア >= demoThreshold の例を成功デモとして収集

round ループ（1 ～ maxRounds）
├── デモ選択: 上位固定 + ランダムサンプルで maxDemos 件を選ぶ
├── Few-shot プロンプトを構築（デモを埋め込み）
└── Student で評価 → ベストより良ければ採用
```

**1 round の流れ**: デモ選択 → Few-shot プロンプト構築 → 評価（全 example 並列）→ 採用判定

---

### GEPAOptimizer

**ループ階層**: `iteration`（最外）→ その中で `trial`（候補生成・評価）

```
iteration（最外ループ: 1 ～ maxIterations）
├── Step A: 全データ評価（並列）
│   └── 現在の bestPrompt を全 examples で評価
├── Step B: 反省 (Reflection)
│   └── Teacher が評価結果を診断し、改善のためのテキスト勾配を生成
├── Step C: 突然変異 (Mutation) — trial フェーズ
│   ├── 親選択（インスタンスフロント頻度）
│   ├── numTrials 個の候補を Teacher で並列生成
│   └── 各候補を全 examples で並列評価 → 採用判定
├── Step D: Merge
│   └── Pareto 上位2候補を Teacher で合成 → 評価 → 採用判定
└── 早期終了: earlyStoppingTrials 回連続で改善なしなら停止
```

**1 iteration の流れ**: 全データ評価 → 反省（1回）→ 親選択 → 候補生成（numTrials 並列）→ 候補評価（全候補・全 example 並列）→ Merge → 早期終了判定

---

### GEPA の FB（反省）とその生成方法

GEPA では **FB（Feedback）** を **反省（Reflection）** または論文用語で **Actionable Side Information (ASI)** と呼ぶ。これは「評価結果を踏まえた改善のための診断テキスト」であり、突然変異（Mutation）で候補プロンプトを生成する際の文脈として使われる。

#### FB とは

- **役割**: 現在のプロンプトの評価結果を Teacher が分析し、「なぜ失敗したか」「どう修正すべきか」を 3〜5 文でまとめたテキスト
- **使用先**: Step C（突然変異）の mutationPrompt に「評価の診断 (Actionable Side Information)」として埋め込み、候補プロンプト生成の指示に含める
- **Merge では未使用**: Merge は Pareto 上位 2 候補のプロンプトのみを合成し、FB は渡さない

#### 生成方法

1. **入力の準備**
   - Step A で `bestPrompt` を全 `task.examples` で評価した結果を取得
   - 評価結果を最大 10 件に制限し、各件について以下を整形:
     - 入力（`inputs` の各フィールド、200 文字まで）
     - 予測（`outputFields` の値）
     - 期待（`expectedOutputs`）
     - スコア（スカラーまたは多目的の各値）

2. **reflectionPrompt の構成**
   ```
   AIシステムのプロンプトを分析しています。

   現在のプロンプト:
   """（bestPrompt）"""

   評価結果（全例）:
   （入力・予測・期待・スコアを整形したテキスト）

   上記の評価結果を踏まえ、スコアが低い例はなぜ失敗しているか、
   スコアが高い例は何が良かったか、プロンプトのどの部分をどう修正すれば
   改善されるかを、具体例を挙げながら丁寧に分析してください。
   ```

3. **Teacher 呼び出し**
   - `runTeacher(client, teacherModel, reflectionPrompt, 0.3)` で生成
   - temperature=0.3（低めで安定した診断を期待）
   - 失敗時はエラーをスロー（フォールバックなし）

4. **突然変異での利用**
   - mutationPrompt に `評価の診断 (Actionable Side Information):\n${reflection}` として埋め込む
   - 親プロンプト・最適化履歴・Pareto 上位候補とともに Teacher に渡し、改善プロンプトを生成させる

---

## 共通型・インターフェース

### OptimizationTask

```typescript
interface OptimizationTask {
  initialPrompt: string;
  inputFields: string[];
  outputFields: string[];
  examples: Example[];
  metric: MetricFn;
  cachedPredictions?: Array<Record<string, string> | undefined>;
}
```

### MetricFn

メトリクスは `number`（0～1）または `Record<string, number>`（多目的）を返す。

```typescript
type MetricFn = (
  prediction: Record<string, string>,
  example: Example
) => number | MetricScores | Promise<number> | Promise<MetricScores>;
```

### OptimizationResult

```typescript
interface OptimizationResult {
  optimizedPrompt: string;
  bestScore: number;
  initialScore: number;
  iterations: number;
  timedOut: boolean;
  log: string[];
  demos?: Demo[];           // BootstrapFewShot のみ
  paretoFront?: Array<...>; // GEPA 多目的時
}
```

---

## 使い方

### クラスを直接使用

```typescript
import { GEPAOptimizer } from "@/lib/promptOptimizer";

const optimizer = new GEPAOptimizer({
  studentModel: "gemini-2.5-flash",
  teacherModel: "gemini-2.5-flash",
  timeoutMs: 60_000,
  verbose: true,
  numTrials: 3,
  maxIterations: 5,
});

const result = await optimizer.optimize({
  initialPrompt: "感情を分析してください。",
  inputFields: ["review"],
  outputFields: ["sentiment"],
  examples: [
    { inputs: { review: "最高でした！" }, expectedOutputs: { sentiment: "positive" } },
  ],
  metric: (pred, ex) => pred.sentiment === ex.expectedOutputs?.sentiment ? 1 : 0,
});

console.log(result.optimizedPrompt);
console.log(`スコア: ${result.bestScore.toFixed(3)}`);
```

### 便利関数 optimizePrompt

```typescript
import { optimizePrompt } from "@/lib/promptOptimizer";

const result = await optimizePrompt("gepa", task, {
  studentModel: "gemini-2.5-flash",
  timeoutMs: 30_000,
  verbose: true,
});
```

---

## 環境変数

| 変数 | 説明 | デフォルト |
|------|------|------------|
| `GEMINI_API_KEY` | Gemini API キー（必須） | — |
| `GOOGLE_APIKEY` | 代替キー（GEMINI_API_KEY が優先） | — |
| `GEPA_MAX_CONCURRENT_CALLS` | LLM 同時呼び出し数の上限 | 20 |
| `GEPA_LOG_LEVEL` | ログレベル: `off` \| `error` \| `info` \| `debug`。`debug` で LLM 呼び出しの開始・終了・所要時間を出力 | `off` |
| `GEPA_LLM_CALL_LOGGING` | 後方互換: `"1"` で `debug` と同等 | 無効 |

**ログレベルの挙動**:
- `off`: ログ出力なし
- `error`: エラー時のみ（LLM 呼び出し失敗、JSON パース失敗など）
- `info`: 最適化の進捗ログ（verbose=true のとき）+ error
- `debug`: LLM 呼び出しの開始・終了・所要時間・応答プレビュー（先頭100文字。FB 含む）+ info + error

---

## アプリケーションとの連携

| 用途 | 呼び出し元 | 備考 |
|------|------------|------|
| Judge プロンプト改善 | `axFewShotJudgeOptimizer`, `axGepaOptimizer` | `lib/infrastructure/ax/` |
| Target プロンプト改善 | `axFewShotTargetOptimizer`, `axGepaTargetOptimizer` | 同上 |
| メトリクス定義 | `gepaMetrics.ts` | `lib/application/promptOptimization/` |
| バジェット・UI 上書き | `gepaRuntimeConfig.ts`, `FewShotBudgetOverridesSchema` | 契約は `lib/contracts/generateEvaluate.ts` |

---

## 並列化

- **evaluatePrompt**: 全 example を `Promise.all` で並列評価
- **GEPA 候補生成**: `numTrials` 個を並列生成
- **GEPA 候補評価**: 全候補を並列評価
- **Bootstrap Phase 1**: 全 example を並列で Teacher に解かせる
- **同時実行数**: `concurrencyLimiter` で `GEPA_MAX_CONCURRENT_CALLS` まで制限

---

## テスト

```bash
npm test -- tests/promptOptimizer/
```

統合テスト: `tests/promptOptimizer/integration.test.ts`
