# AGENTS.md

このファイルは、このリポジトリ（`llm-as-a-judge-mvp`）で作業するエージェント向けの実務ガイドです。  
目的は「既存仕様を壊さず、最小変更で高品質に改善する」ことです。

## 0. 作業ディレクトリ
- 既定の作業ディレクトリはリポジトリルート（この `AGENTS.md` がある階層）
- コマンドは原則この階層で実行する

## 1. プロダクト目的
- 職務経歴テキストを要約し、LLMで評価するMVP
- 生成（Target）と評価（Judge）はAPIとして分離済み
- データ保存はしない（履歴・DBなし）

## 2. 現在の主要構成（必ず尊重）
- UI: `app/page.tsx`
- API:
  - `app/api/generate/route.ts`
  - `app/api/judge/route.ts`
  - `app/api/domain-config/route.ts`
  - `app/api/generate-evaluate/route.ts`（後方互換）
  - `app/api/gepa-jobs/route.ts` - GEPA ジョブ投入
  - `app/api/gepa-jobs/[jobId]/route.ts` - GEPA ジョブ状態取得
  - `app/api/weave/human-feedback/route.ts` - Weave 人間評価取得
  - `app/api/weave/judge-logs/route.ts` - Weave Judge ログ取得
  - `app/api/weave/debug/route.ts` - Weave 診断
- 契約（zod）:
  - `lib/contracts/generateEvaluate.ts`
- LLMプロバイダ:
  - `lib/domain/llm.ts`
  - `lib/infrastructure/gemini/GeminiProvider.ts`
  - `lib/infrastructure/llmProviderFactory.ts`
- ドメイン設定:
  - `lib/config/domainPromptConfigs.ts`（プロンプト・サンプル定義）
  - `lib/config/domainPromptLoader.ts`
  - `lib/config/resumeSummaryPromptLoader.ts`
- Weave インフラ:
  - `lib/infrastructure/weave/weaveClient.ts` - クライアント初期化
  - `lib/infrastructure/weave/weaveProjectId.ts` - project_id（entity/project 形式）
  - `lib/infrastructure/weave/weaveLogger.ts` - Trace 記録
  - `lib/infrastructure/weave/weaveQuery.ts` - Trace API から取得

## 3. 変更時の必須ルール
- API/レスポンス形式を変えるときは、先に `lib/contracts/generateEvaluate.ts` を更新する
- 仕様変更時は、UI・API・README・テストを同一PRで整合させる
- 既存のエラーコード体系を壊さない（`INVALID_JSON` / `VALIDATION_ERROR` など）
- 想定内エラーは `AppError` を使って返却する
- 機密情報（`GEMINI_API_KEY`）をクライアントへ露出しない
- Gemini APIの直接呼び出しは `GeminiProvider` に集約する
- Judge/Target/GEPA の学習データ取得は `lib/application/promptOptimization/gepaDataLoader.ts` を再利用し、同一挙動を維持する
- GEPA/Few-shot など最適化処理でフォールバック分岐を実装しない（失敗時は根本原因を修正する）

## 4. プロンプト/サンプル運用ルール
- 現行ドメインは `resume_summary` / `resume_detail` / `self_pr`
- プロンプト・サンプルは `lib/config/domainPromptConfigs.ts` で定義
  - `{{RUBRIC_BULLETS}}` はルーブリックから自動展開
- `domainPromptLoader` はキャッシュするため、設定反映確認時はサーバー再起動を前提にする

## 5. UI実装ルール
- 画面文言は日本語中心で統一
- 現在の主要UXを維持:
  - 全体タブ（`生成` / `評価`）
  - 生成と評価の分離実行
  - Progress段階表示
- アクセシビリティ属性（`aria-*`, `role`, `tabIndex`）を削除しない

## 6. テスト方針
- API変更時:
  - `tests/api/*.test.ts` を更新/追加
- 設定ローダー変更時:
  - `tests/config/resumeSummaryPromptLoader.test.ts` を更新
- UI変更時:
  - タブ遷移（`生成`/`評価`）と主要ボタンの有効・無効条件を手動確認する
- 実装完了時の最低確認:
  1. `npm test`
  2. `npm run lint`
  3. `npm run build`

## 7. 変更チェックリスト（PR前）
1. 契約変更がある場合、zodスキーマと型を更新した
2. API実装とフロント型ガードが一致している
3. READMEのUI/API説明を最新化した
4. テストを追加・更新し、全て成功した
5. 不要なファイル（デバッグログ/一時ファイル）を残していない

## 8. Weave 関連の注意
- `project_id` は `entity/project` 形式で統一。`weaveProjectId.ts` の `getWeaveProjectId()` を使用
- Trace API の `op_name` はフル URI 形式のため、`op_names` フィルタではなく `query` の `$contains` を使用
- domain フィルタは Trace API の `query` で `$getField("inputs.domain")` を指定

## 9. GEPA / Few-shot / GEPA Queue の注意
- GEPA の iteration / trial の仕組み・パラメータ・並列化は `lib/promptOptimizer/GEPA.md` を参照
- GEPA 実装は `lib/promptOptimizer/GEPAOptimizer.ts`（`@ax-llm/ax` の AxGEPA ではない）
- Few-shot 実装は `lib/promptOptimizer/BootstrapFewShotOptimizer.ts`（`@ax-llm/ax` の AxBootstrapFewShot ではない）
- GEPA キューは `lib/application/gepaJobService.ts` が担当し、状態は既定で `/tmp/llm-as-a-judge-mvp/gepa-jobs-state.json` に保存する
- 復旧時は `running` を `queued` に戻して再実行する
- `GEPA_JOB_STATE_FILE` を設定すると保存先を変更できる
- この状態ファイルはジョブ制御用途であり、DB導入を意味しない（プロダクト履歴の永続化には使わない）

## 10. 非目標（勝手に拡張しない）
- 永続化（DB/履歴）追加
- モデル設定UIの追加
- 認証・認可の導入
- ドメイン多言語化/多テナント化

要望がある場合のみ段階的に導入する。
