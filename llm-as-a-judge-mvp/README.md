# 職務経歴書アシスタント MVP (Gemini)

## Overview

単一ページで以下を実行する最小実装です。

1. 職務経歴テキストを Target LLM へ送信して生成（要約 / 職務経歴詳細 / 自己PR）
2. 生成結果を Judge LLM で評価
3. Score / Reason / 合格判定を表示
4. **人間フィードバック**: 生成結果に対するあなたのスコア・コメントを送信（Judge プロンプト改善に活用）
5. **W&B 連携**: WANDB_API_KEY 設定時、生成・評価・人間評価を wandb にログ
6. **Weave プロンプト管理**: プロンプトを Weave に publish し、バージョン管理・比較を可能に

### 対応ドメイン

| ドメイン ID | ラベル | 説明 |
|------------|--------|------|
| `resume_summary` | 職務要約 | 採用担当向けの簡潔な要約（3〜6文） |
| `resume_detail` | 職務経歴（詳細） | 構造化された職務経歴（会社・期間・業務・実績の数値化） |
| `self_pr` | 自己PR | 200〜400文字の自己PR文（2〜3個の強み） |

---

## システム構成

### アーキテクチャ

```
ユーザー（職務経歴入力） → 生成エージェント（Target LLM） → 評価エージェント（Judge LLM）
                                    ↑                              ↓
                                    └── プロンプト改善 ←── 人間フィードバック収集
                                                                    ↓
                                              W&B（Traces / Table / Artifact / Prompts）
```

### コンポーネント

| コンポーネント | 役割 |
|---------------|------|
| 生成エージェント | 職務経歴から職務要約・職務経歴詳細・自己PRを生成 |
| 評価エージェント | LLM-as-a-Judge で生成結果を評価 |
| 人間評価収集 | ユーザーが生成結果に対してスコア・コメントを付与 |
| Judge プロンプト改善 | 人間評価を教師信号として Judge プロンプトの改善案を LLM 生成 |
| 生成プロンプト改善 | Judge 結果を教師信号として生成プロンプトの改善案を LLM 生成 |
| W&B 連携 | ログ・評価・プロンプトの一元管理 |

### W&B / Weave データフロー

| データ | 保存先 |
|-------|--------|
| 生成・評価・人間評価 | Weave Traces（`generate_log`, `judge_log`, `human_feedback_log`） |
| Judge 評価結果 | メモリ（生成プロンプト改善の失敗ケース収集に利用） |
| プロンプト | Weave Prompts（バージョン管理・比較） |

**Weave Trace の保存先**: `https://wandb.ai/{entity}/{project}` の Traces タブ

---

## Tech Stack

| 項目 | 技術 |
|-----|------|
| フレームワーク | Next.js (App Router, TypeScript) |
| LLM | Gemini API（`@ax-llm/ax` / `@google/genai`） |
| 永続化・実験管理 | wandb（Table, Artifact）、W&B Weave（Traces, Prompts） |
| プロンプト管理 | Weave Prompts、`lib/config/domainPromptConfigs.ts` |

### LLM プロバイダ（プロンプト改善タブで選択）

Judge プロンプト改善・生成プロンプト改善タブの右側で選択可能:

- **ax**: `@ax-llm/ax` を使用。シグネチャ（入出力宣言）でプロンプトを自動生成。
  - **Few-shot**（既定）: `AxBootstrapFewShot` を使った最適化。Weave から取得した実ログ（Judge/Target）を最適化データとして利用
  - **GEPA**: `lib/promptOptimizer` の `GEPAOptimizer` による本格的な最適化
- **Gemini**: `@google/genai` を直接使用。

生成・評価タブの ax 実行はシンプルなシグネチャ実行（実質ゼロショット）で統一。

### 最適化手法の解説（`improvementMethod`）

プロンプト改善タブでは、`ax` プロバイダ選択時に以下 3 手法を切り替えられます。

| 手法 | ねらい | 主な入力データ | 速度 / 品質の傾向 |
|------|--------|----------------|-------------------|
| `meta` | 既存プロンプトをLLMに分析させ、改善文面を提案 | Weave から取得した直近ログ（最大数件） | 速い / 改善の安定性はデータ依存 |
| `fewshot` | 実例（入出力ペア）を使って、模倣しやすい改善案を作る | 実ログを few-shot 例として再構成したデータ | 中程度 / 実例に沿った改善が得やすい |
| `gepa` | 複数目的（精度・安定性など）を反復最適化 | 実ログ + GEPA の探索設定 | 遅い / 最も本格的で高品質を狙いやすい |

#### 1. `meta`（メタプロンプト改善）

- 概要: 既存の instruction と評価ログをテキストで渡し、LLM に「分析サマリー」と「改善案」を直接生成させる手法です。
- 特徴: 実装が軽く、少ないデータでも動作します。改善の方向性を素早く確認したいときに向いています。
- 注意点: モデルの推論に依存するため、同じ入力でも提案のばらつきが出る場合があります。

#### 2. `fewshot`（例示ベース最適化）

- 概要: `AxBootstrapFewShot` を使い、実ログから作った「入力→望ましい出力」の例をデモとして最適化します。
- Judge 改善時: 人間評価スコアに近づくように最適化します。
- Target 改善時: Judge のスコアを内部指標として、生成品質が上がる方向に最適化します。
- 特徴: 実例に沿った改善が得られやすく、`meta` より実務ログの反映度が高いです。
- 注意点: 元データの偏りがあると、その偏りを学習する可能性があります。

#### 3. `gepa`（多目的最適化）

- 概要: `lib/promptOptimizer` の `GEPAOptimizer` で候補プロンプトを反復的に探索し、評価指標の改善を狙う手法です。
- 特徴: 探索的に候補を比較するため、3手法の中で最も本格的な最適化です。
- 運用: UI では非同期ジョブ（`/api/gepa-jobs`）として実行し、状態を取得して結果を反映します。
- 注意点: 実行時間が長くなる場合があります。失敗時はエラーを返します。
- 詳細: iteration / trial の仕組みなどは `lib/promptOptimizer/GEPA.md` を参照。

#### 手法選択の目安

- まずは短時間で方向性を見たい: `meta`
- 実ログを活かして着実に改善したい: `fewshot`（既定）
- 時間をかけて高品質な候補を探索したい: `gepa`

### Fixed Model Settings

- Target LLM: `gemini-2.5-flash`
- Judge LLM: `gemini-2.5-pro`

---

## Prompt Configuration

- ドメイン定義は `lib/config/domainPromptConfigs.ts` に定義
- サーバー起動中は読み込み結果をメモリキャッシュ
- `{{RUBRIC_BULLETS}}` をルーブリックから自動展開
- プロンプト初回ロード時および `POST /api/prompts/sync-to-weave` で Weave に publish

---

## Architecture（ファイル構成）

- `app/api/generate/route.ts` - 生成 API
- `app/api/judge/route.ts` - 評価 API
- `app/api/domain-config/route.ts` - ドメイン設定取得
- `app/api/domains/route.ts` - ドメイン一覧
- `app/api/generate-evaluate/route.ts` - 後方互換の統合 API
- `app/api/human-feedback/route.ts` - 人間評価の登録・一覧
- `app/api/judge-prompt/improve/route.ts` - Judge プロンプト改善案生成
- `app/api/target-prompt/improve/route.ts` - 生成プロンプト改善案生成
- `app/api/wandb-status/route.ts` - W&B 設定状態
- `app/api/weave/human-feedback/route.ts` - Weave 人間評価取得
- `app/api/weave/judge-logs/route.ts` - Weave Judge ログ取得
- `app/api/weave/debug/route.ts` - Weave 診断
- `app/api/prompts/sync-to-weave/route.ts` - プロンプト Weave 同期
- `lib/application/` - ユースケース層
- `lib/domain/llm.ts` - ドメイン型・プロバイダインターフェース
- `lib/infrastructure/ax/AxProvider.ts` - ax（DSPy 風）による Gemini 実装（既定）
- `lib/infrastructure/gemini/GeminiProvider.ts` - 従来の Gemini 実装
- `lib/infrastructure/humanFeedbackStore.ts` - 人間評価保存（メモリ + Weave）
- `lib/infrastructure/weave/weaveClient.ts` - Weave クライアント初期化
- `lib/infrastructure/weave/weaveProjectId.ts` - project_id 取得（entity/project 形式）
- `lib/infrastructure/weave/weaveLogger.ts` - 生成・評価・人間評価の Trace 記録
- `lib/infrastructure/weave/weaveQuery.ts` - Trace API からログ取得
- `lib/infrastructure/weave/promptManager.ts` - Weave プロンプト publish
- `lib/config/domainPromptConfigs.ts` - プロンプト・サンプル定義
- `lib/contracts/generateEvaluate.ts` - 契約（zod）

---

## UI

- 生成モード選択（職務要約 / 職務経歴（詳細） / 自己PR）
- `生成` / `評価` タブ切り替え
- Progress 表示（Input accepted → Generating → Generated → Judging → Completed）
- サンプル入力ボタン（3種類）
- 人間フィードバック（生成結果へのスコア・コメント）
- Judge / 生成プロンプト改善案生成
- 「Weave からデータを取得」ボタン（Judge/生成プロンプト改善タブ）
- Weave プロンプト同期、W&B ダッシュボードリンク

---

## Setup

1. Install dependencies

```bash
npm install
```

2. Set environment variable

```bash
cp .env.example .env.local
# edit .env.local and set GEMINI_API_KEY
# (optional) WANDB_API_KEY, WANDB_PROJECT, WANDB_ENTITY for wandb/Weave
```

3. (Optional) wandb / Weave を使う場合

```bash
npm install weave   # Weave トレース・プロンプト管理用（package.json に含まれる）
```

**環境変数（Weave 利用時）**

| 変数 | 必須 | 説明 |
|------|------|------|
| `WANDB_API_KEY` | ○ | W&B API キー（[wandb.ai/settings](https://wandb.ai/settings) で取得） |
| `WANDB_PROJECT` | △ | プロジェクト名（未設定時: `resume-assistant`） |
| `WANDB_ENTITY` | 推奨 | W&B ユーザー/チーム名。未設定時は API からデフォルト entity を取得 |

4. Start dev server

```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000)

6. Run tests

```bash
npm test
```

---

## API

| エンドポイント | 説明 |
|---------------|------|
| `POST /api/generate` | 生成 |
| `POST /api/judge` | 評価 |
| `GET /api/domain-config?domain=` | ドメイン設定取得 |
| `GET /api/domains` | ドメイン一覧 |
| `POST /api/human-feedback` | 人間評価を登録 |
| `GET /api/human-feedback` | 人間評価一覧（クエリ: `domain`, `limit`） |
| `POST /api/judge-prompt/improve` | Judge プロンプト改善案を LLM 生成 |
| `POST /api/target-prompt/improve` | 生成プロンプト改善案を LLM 生成 |
| `POST /api/gepa-jobs` | GEPA 最適化ジョブを非同期で投入（`ax + gepa` 専用） |
| `GET /api/gepa-jobs/:jobId` | GEPA 最適化ジョブの状態・結果を取得 |
| `GET /api/wandb-status` | W&B 設定状態（`configured`, `dashboardUrl`） |
| `GET /api/weave/human-feedback?domain=&limit=` | Weave から人間評価ログ取得（Judge 改善用） |
| `GET /api/weave/judge-logs?domain=&limit=` | Weave から Judge 評価ログ取得（生成プロンプト改善用） |
| `GET /api/weave/debug` | Weave 状態診断（project_id、件数、op 一覧） |
| `POST /api/prompts/sync-to-weave` | プロンプトを Weave に同期 |

**GEPA キュー実装メモ**
- ジョブ状態はサーバー側キューで管理され、既定で `/tmp/llm-as-a-judge-mvp/gepa-jobs-state.json` に保存されます（`GEPA_JOB_STATE_FILE` で変更可）。
- プロセス再起動時は `running` ジョブを `queued` として再実行します。
- Weave が有効で取得に成功した場合、0件でもその結果を採用します（ローカルメモリへのフォールバックは取得エラー時のみ）。

### Request / Response 例

**Generate Request**

```json
{
  "userInput": "2019年にSIerへ入社し...",
  "domain": "resume_summary"
}
```

**Judge Request**

```json
{
  "userInput": "...",
  "generatedOutput": "...",
  "domain": "resume_summary"
}
```

**Judge Response**

```json
{
  "domain": "resume_summary",
  "rubricVersion": 1,
  "passThreshold": 4,
  "pass": true,
  "score": 4,
  "reason": "..."
}
```

### Validation

- `userInput`: 必須、4000 文字以内
- `generatedOutput`: 必須、12000 文字以内

### Error Codes

`INVALID_JSON` / `VALIDATION_ERROR` / `CONFIG_ERROR` / `PROVIDER_TIMEOUT` / `PROVIDER_RESPONSE_INVALID` / `PROVIDER_ERROR` / `INTERNAL_ERROR`

---

## Weave トラブルシューティング

**「Weave からデータを取得」で 0 件になる場合**

1. **診断 API を確認**: `GET /api/weave/debug` で `projectId`、`counts`、`diagnostic` を確認
2. **環境変数**: `WANDB_ENTITY` を設定し、サーバーを再起動
3. **データの有無**: 生成 → 評価 → 手動評価の順で実行すると Weave に保存される
4. **ドメイン**: 選択中のドメイン（職務要約 / 職務経歴（詳細） / 自己PR）にデータがあるか確認

**技術メモ**

- Trace API の `op_name` はフル URI 形式（`weave:///entity/project/op/name:hash`）で返るため、`$contains` でフィルタ
- `project_id` は `entity/project` 形式で保存・取得を統一（`weaveProjectId.ts`）
- domain フィルタは Trace API の `query` で `inputs.domain` を指定

---

## 非機能要件

- 既存 API の後方互換性を維持
- wandb をデータ保存の中核とする
- 人間評価はスコアのみでも送信可能（コメント任意）
- プロンプト改善は自動適用せず、人間がレビューして反映

---

## 用語集

| 用語 | 説明 |
|-----|------|
| 生成エージェント | 職務経歴から職務要約・自己PR等を生成する LLM（Target LLM） |
| 評価エージェント | 生成結果を LLM-as-a-Judge で評価する LLM（Judge LLM） |
| 人間フィードバック | ユーザーが生成結果に付与するスコア・コメント |
| ルーブリック | Judge の評価観点（`domainPromptConfigs` の `judgeRubric`） |
| ドメイン | 生成モード（resume_summary / resume_detail / self_pr） |

---

## 参考リンク

- [Weave Service API (Trace)](https://docs.wandb.ai/weave/cookbooks/weave_via_service_api)
- [W&B Weave Evaluation Tutorial](https://docs.wandb.ai/weave/tutorial-eval)
- [W&B Log Tables](https://docs.wandb.ai/models/track/log/log-tables)
- [W&B Artifacts](https://docs.wandb.ai/models/artifacts)
- [W&B Prompts](https://docs.wandb.ai/weave/guides/core-types/prompts)
