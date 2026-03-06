# GEPA オプティマイザ — ドキュメント

## 概要

`GEPAOptimizer` は **反省的プロンプト進化 (Reflective Prompt Evolution)** を実装したプロンプト最適化器です。

- **参考論文**: "GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning" (Gallotta et al., ICLR 2026 — arXiv:2507.19457)
- **実装**: `lib/promptOptimizer/GEPAOptimizer.ts`

### 主な機能

- **多目的最適化（スカラー化なし）**: メトリクスが `Record<string, number>` を返す場合、Pareto 支配のみで比較。重み付き合計は行わない
- **インスタンスフロント**: 各 example で Pareto 非支配の候補を求め、その頻度で親をサンプリング
- **ベスト選択**: Pareto frontier から辞書式順序（第一目的優先）で1件を選択

---

## ループ階層（iteration / trial）

### 構造

```
iteration（最外ループ: 1 ～ maxIterations）
├── Step A: 全データ評価（並列）
│   └── 現在の bestPrompt を全 examples で評価
├── Step B: 反省 (Reflection)
│   └── Teacher LLM が評価結果を診断し、改善のためのテキスト勾配を生成
├── Step C: 突然変異 (Mutation) — trial フェーズ
│   └── numTrials 個の候補プロンプトを並列生成
│       └── 各候補を全データで並列評価 → 採用判定
├── Step D: Merge
│   └── Pareto Frontier 上位2候補を Teacher LLM で合成
└── 早期終了判定
    └── earlyStoppingTrials 回連続で改善なしなら停止
```

### 用語の定義

| 用語 | 意味 | デフォルト |
|------|------|------------|
| **iteration** | 最外ループの1回。反省→候補生成→Merge までが1 iteration | maxIterations=5 |
| **trial** | 1 iteration 内で生成する候補プロンプトの数。並列で numTrials 個生成 | numTrials=3 |
| **earlyStoppingTrials** | 改善なしが何 iteration 連続したら停止するか | 2 |

### 1 iteration の流れ

1. **全データ評価**: `bestPrompt` を全 `task.examples` で評価（`Promise.all` で並列）
2. **反省**: 評価結果（最大10件）を Teacher LLM に渡し、「なぜ失敗したか」「どう改善すべきか」を診断
3. **親選択（インスタンスフロント頻度）**: 各 example で最良スコアを持つ候補の集合（instance front）を構築し、フロントに含まれた回数に比例する確率で親をサンプリング
4. **突然変異**: 選ばれた親プロンプト + 反省 + 履歴 + Pareto 上位3件を文脈に、Teacher LLM で `numTrials` 個の候補を**並列生成**
5. **候補評価**: 各候補を全データで**並列評価**し、`bestScore` を超えたら採用
6. **Merge**: population が2件以上あれば、スコア上位2件を Teacher LLM で合成。合成結果が bestScore を上回れば採用
7. **早期終了**: この iteration で改善がなければ `noImprovementCount` をインクリメント。`earlyStoppingTrials` に達したらループ終了

---

## 主要パラメータ

| パラメータ | 型 | デフォルト | 説明 |
|------------|-----|------------|------|
| `numTrials` | number | 3 | 1 iteration あたりの候補生成数。多いほど探索が広がるが時間がかかる |
| `maxIterations` | number | 5 | 最大 iteration 数 |
| `earlyStoppingTrials` | number | 2 | 改善なしが何 iteration 連続したら停止するか |
| `studentModel` | string | gemini-2.5-flash | プロンプトを実行するモデル |
| `teacherModel` | string | gemini-2.5-flash | 反省・候補生成・Merge を行うモデル |
| `timeoutMs` | number | なし | 指定時間経過で打ち切り、それまでのベストを返す |

**注**: `minibatchSize` は型定義に残るが、現在の実装では未使用（常に全データ評価）。

---

## Pareto Frontier（候補集団）

- **population**: スコア上位最大10件の候補を保持
- **採用条件**: 候補のスコアが `bestScore` を上回れば population に追加
- **Merge 対象**: スコア上位2件を合成。同一プロンプトの場合はスキップ
- **多目的時**: Pareto 非支配解を保持。`bestScore` はスカラー化後の最大値。結果に `paretoFront` を含む

## インスタンスフロント頻度（親選択）

- **instance front**: 各 example について、どの候補が最良（または同点）かを求めた集合
- **親選択**: フロントに含まれた回数に比例する確率で親をサンプリング
- **効果**: 異なる example で強い候補が親として選ばれやすくなり、多様な探索が可能になる

---

## メトリクス

- **入力**: `task.metric(prediction, example)` が以下を返す:
  - **スカラー**: `number`（0～1）— 単一目的
  - **ベクトル**: `Record<string, number>`（各値 0～1）— 多目的
- **多目的時**: スカラー化せず Pareto 支配のみで比較。ベストは辞書式（第一目的優先）
- **Judge**: `{ scoreAgreement, reasonLength }`
- **Target**: `{ score, formatScore }`

---

## 並列化

| 処理 | 並列化 |
|------|--------|
| 全データ評価（Step A） | `Promise.all` で全 example を並列 |
| 候補生成（Step C） | `Promise.all` で numTrials 個を並列 |
| 候補評価（Step C） | `Promise.all` で全候補を並列 |
| `evaluatePrompt`（runner） | 内部で全 example を `Promise.all` 並列 |

---

## 実行コストの目安

- **1 iteration あたり**:
  - 全データ評価: `examples.length` 回の Student 呼び出し
  - 反省: 1 回の Teacher 呼び出し
  - 候補生成: `numTrials` 回の Teacher 呼び出し
  - 候補評価: `numTrials × examples.length` 回の Student 呼び出し
  - Merge: 0～1 回の Teacher + 1 回の Student

- **最大**: `maxIterations × (上記)` まで。早期終了で短縮される。

---

## 関連ファイル

| ファイル | 役割 |
|----------|------|
| `lib/promptOptimizer/GEPAOptimizer.ts` | GEPA 本体 |
| `lib/promptOptimizer/runner.ts` | `runProgram`, `evaluatePrompt`, `runTeacher` |
| `lib/promptOptimizer/types.ts` | `GEPAOptions`, `OptimizationTask` |
| `lib/application/promptOptimization/gepaMetrics.ts` | Judge/Target 用メトリクス |
| `lib/application/promptOptimization/gepaRuntimeConfig.ts` | バジェット定義（UI 用） |
| `lib/infrastructure/ax/axGepaOptimizer.ts` | Judge 用 GEPA 呼び出し |
| `lib/infrastructure/ax/axGepaTargetOptimizer.ts` | Target 用 GEPA 呼び出し |
