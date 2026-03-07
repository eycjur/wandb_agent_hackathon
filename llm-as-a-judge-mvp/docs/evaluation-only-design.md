# 評価専用ユースケース対応 設計メモ

## 1. 背景

現状の評価タブは、生成タブで作成した `generatedOutput` をそのまま評価する前提になっている。

- 評価タブは `generatedOutput` / `generatedForInput` が空だと実行できない
- 評価対象の文章は `pre` 表示で、編集や外部文章の貼り付けができない
- Judge ログと人間評価ログは「生成結果を評価した」前提の意味を持っている

一方で、今後は以下の評価専用ユースケースに対応したい。

- 外部で作成した職務要約 / 職務経歴 / 自己PRを Judge だけにかけたい
- 生成結果を人手で微修正したうえで評価したい
- 生成を行わず、元の職務経歴入力と評価対象文だけを手入力して評価したい

## 2. 目的

- 既存の `生成 -> 評価` フローを壊さずに、`評価のみ` でも使えるようにする
- 評価タブ上で、元入力と評価対象文を編集可能にする
- 手入力 / 外部貼り付け / 生成結果編集の区別をログに残し、後続のプロンプト改善に悪影響を出さないようにする

## 3. 非目標

- 元の職務経歴入力がない状態での評価対応
- ファイルアップロード、バッチ評価、履歴永続化
- モデル設定 UI の追加
- 生成 API / Judge プロンプト自体の大幅な変更

元の職務経歴入力がない評価は、現行 Judge の前提を崩すため今回の範囲から外す。

## 4. 現状の問題点

### 4.1 UI

- 評価タブは `generatedOutput` を参照表示するだけで、評価対象を編集できない
- 評価タブが「評価対象の確定画面」ではなく「生成結果の閲覧画面」になっている

### 4.2 状態管理

- `DomainSessionState` は生成結果中心で、評価用のドラフト状態を持っていない
- 評価実行後にテキストを編集した場合、表示中の評価結果が最新テキストに対するものか判別しづらい

### 4.3 ログ / 改善

- Judge ログと人間評価ログが、すべて「生成モデルが出した文章」のように扱われる
- 外部文章や人手修正文をそのまま生成プロンプト改善に流すと、学習対象が汚染される

## 5. 変更方針

評価タブを「生成結果の表示」ではなく「評価対象を確定して評価する画面」に変更する。

要点は以下。

1. 評価タブに `元の職務経歴入力` と `評価対象文` の編集領域を追加する
2. 生成結果は評価ドラフトの初期値として読み込めるようにする
3. 評価時には、画面上のドラフト値をそのまま `/api/judge` に送る
4. 評価データに `sourceType` を付与し、改善系で利用可否を分ける

## 6. UI 設計

## 6.1 タブ構成

メインタブ構成は変えない。

- `生成`
- `評価`
- `Judge プロンプト改善`
- `生成プロンプト改善`

`評価専用` の新規タブは追加しない。既存の `評価` タブを拡張する。

理由:

- 既存 UX の維持に合う
- 「生成後にそのまま評価」と「評価だけ」を同じ概念で扱える
- 実装差分を最小にできる

## 6.2 評価タブのレイアウト

評価タブは以下の構成にする。

1. 操作行
2. 左カラム: 評価対象ドラフト
3. 右カラム: 自動評価結果
4. 手動評価
5. Progress

### 6.2.1 操作行

- `直近の生成結果を読み込む`
- `入力をクリア`
- `評価する`

補助表示:

- 現在の入力元バッジ
  - `生成結果`
  - `生成結果を編集`
  - `手入力 / 貼り付け`
- 最新の生成結果が未反映の場合の注意文

### 6.2.2 左カラム: 評価対象ドラフト

入力欄を 2 つ持つ。

- `元の職務経歴入力`
- `評価対象の文章`

ドメイン別ラベル:

- `resume_summary`: `評価対象の職務要約`
- `resume_detail`: `評価対象の職務経歴（詳細）`
- `self_pr`: `評価対象の自己PR`

補助文言:

- 生成タブの結果を読み込んで編集できます
- 外部で作成した文章を貼り付けて評価できます
- 評価には元の職務経歴入力も必要です

### 6.2.3 右カラム: 自動評価結果

既存のスコアカードを流用するが、表示対象は「現在の生成結果」ではなく「最後に評価したドラフト」に変える。

追加表示:

- `編集中の内容はまだ評価していません` の警告

表示条件:

- `currentResult` があり、かつ現在のドラフト値が `currentResult.userInput` または `currentResult.generatedOutput` と異なる場合に表示する

### 6.2.4 手動評価

手動評価は現行どおり評価タブ内に残すが、対象は `generatedOutput` 固定ではなく「最後に Judge した内容」または「Judge 前のドラフト内容」に切り替える。

ルール:

- Judge 実行後は `currentResult.userInput` / `currentResult.generatedOutput` を送る
- Judge 実行前は現在のドラフト値を送る
- ただし、Judge 実行後にドラフトを編集した場合は、Judge 結果との不整合を避けるため `評価を送信` を無効化する

無効化条件:

- `humanScore === null`
- 送信中
- `currentResult` が存在し、かつドラフト内容が `currentResult` と一致しない

## 7. 状態管理設計

## 7.1 基本方針

既存の `DomainSessionState` を大きく分割せず、最小変更で評価ドラフト用フィールドを追加する。

理由:

- 既存コードは `patchDomainSession` による浅い更新を前提にしている
- ここで入れ子構造へ全面変更すると影響範囲が過大になる

## 7.2 追加フィールド

`DomainSessionState<TResult>` に以下を追加する。

```ts
type DomainSessionState<TResult> = {
  generatedOutput: string;
  generatedForInput: string;
  lastGeneratedInput: string;
  evaluationDraftUserInput: string;
  evaluationDraftOutput: string;
  evaluationDraftSeedUserInput: string;
  evaluationDraftSeedOutput: string;
  hasPendingGeneratedDraft: boolean;
  currentResult: TResult | null;
  previousResult: TResult | null;
  progressStage: ProgressStage;
  requestError: string;
};
```

意味:

- `evaluationDraftUserInput`
  - 評価画面で現在編集している元入力
- `evaluationDraftOutput`
  - 評価画面で現在編集している評価対象文
- `evaluationDraftSeedUserInput`
  - 直近で「生成結果を読み込む」したときの元入力
- `evaluationDraftSeedOutput`
  - 直近で「生成結果を読み込む」したときの評価対象文
- `hasPendingGeneratedDraft`
  - 新しい生成結果があるが、現ドラフトへ未反映であることを示す

## 7.3 sourceType の導出

`sourceType` は保存時に次のルールで導出する。

```ts
if (evaluationDraftSeedUserInput && evaluationDraftSeedOutput) {
  if (
    evaluationDraftUserInput === evaluationDraftSeedUserInput &&
    evaluationDraftOutput === evaluationDraftSeedOutput
  ) {
    return "generated";
  }
  return "generated_edited";
}
return "manual";
```

この方式にすると、画面編集中に逐一 `sourceType` を更新しなくてよい。

## 7.4 生成成功時のドラフト同期ルール

生成成功時は、`generatedOutput` / `generatedForInput` を更新したうえで、評価ドラフトへの反映を以下で制御する。

### 自動反映する条件

- 評価ドラフトが空
- もしくは現在のドラフトが seed と完全一致している

### 自動反映しない条件

- 評価ドラフトが手入力済み
- 生成結果を読み込んだ後にユーザーが編集済み

自動反映しない場合:

- `hasPendingGeneratedDraft = true`
- UI に `新しい生成結果があります。「直近の生成結果を読み込む」で反映できます。` を表示する

この挙動により、評価中の手入力内容を誤って上書きしない。

## 8. API / 契約設計

## 8.1 追加スキーマ

`lib/contracts/generateEvaluate.ts` に以下を追加する。

```ts
export const EvaluationSourceTypeSchema = z.enum([
  "generated",
  "generated_edited",
  "manual"
]);
```

## 8.2 `/api/judge`

### リクエスト

`JudgeRequestSchema` に `sourceType` を追加する。

```ts
sourceType: EvaluationSourceTypeSchema.optional().default("generated")
```

後方互換:

- 既存クライアントは未送信でも動く
- 現行画面からの利用は従来どおり `generated` 扱い

### レスポンス

レスポンス形式は変更しない。

理由:

- Judge 自体の判定結果に `sourceType` は不要
- UI 側は送信時点のドラフト状態を保持できる

## 8.3 `/api/human-feedback`

`HumanFeedbackRequestSchema` に `sourceType` を追加する。

```ts
sourceType: EvaluationSourceTypeSchema.optional().default("generated")
```

`HumanFeedbackRecordSchema` にも `sourceType` を追加する。

## 8.4 互換性方針

API 破壊的変更は避ける。

- 新規フィールドは optional で受ける
- ログ取得側では `sourceType` 不在時に `generated` 扱いする

## 9. ドメイン型 / 結果型設計

UI 内の `EvaluationResult` に `sourceType` を追加する。

```ts
type EvaluationResult = {
  domain: DomainId;
  rubricVersion: number;
  passThreshold: number;
  pass: boolean;
  userInput: string;
  generatedOutput: string;
  sourceType: "generated" | "generated_edited" | "manual";
  score: number;
  reason: string;
  createdAt: string;
};
```

理由:

- 手動評価送信時に、Judge 済み内容との整合を保てる
- `previousResult` の意味が「前回の生成結果」ではなく「前回評価した内容」になる

## 10. ログ / 保存設計

## 10.1 評価ログ

`evaluationLogStore` の記録に `sourceType` を追加する。

```ts
type EvaluationLogRecord = {
  ...
  sourceType: "generated" | "generated_edited" | "manual";
};
```

Judge API では、受け取った `sourceType` をそのまま保存する。

## 10.2 人間評価ログ

`humanFeedbackStore` の記録に `sourceType` を追加する。

Judge 実行前の手動評価でも、現在のドラフトから `sourceType` を導出して保存する。

## 10.3 Weave ログ

以下の Weave パラメータに `sourceType` を追加する。

- `logJudge`
- `logHumanFeedback`

`logGenerate` は変更しない。

## 10.4 Weave 取得時の互換

`weaveQuery.ts` の `JudgeLogFromWeave` / `HumanFeedbackFromWeave` に `sourceType?: string` を追加する。

変換時ルール:

- `sourceType` が存在すればそれを使う
- ない場合は `generated` とみなす

## 11. プロンプト改善への影響

## 11.1 Judge プロンプト改善

Judge 改善では、以下を利用対象に含める。

- `generated`
- `generated_edited`
- `manual`

理由:

- Judge 改善の目的は「人間評価との整合」であり、文章の出どころより評価基準の一致が重要

## 11.2 生成プロンプト改善

生成プロンプト改善では、以下のみ利用する。

- `generated`

除外対象:

- `generated_edited`
- `manual`

理由:

- 人手修正文や外部文章は、Target LLM の出力分布を表さない
- これらを混ぜると、生成失敗ケースの原因分析が壊れる

対象箇所:

- `loadTargetFailuresForPromptOptimization`
- `loadTargetExamplesForFewShot`
- Weave 由来データの変換後フィルタ

## 12. 主要画面挙動

## 12.1 初回表示

- 生成結果がある場合でも、自動で評価できる状態にしてよい
- ただし、評価ドラフトはセッション状態として保持する

## 12.2 `直近の生成結果を読み込む`

動作:

- `evaluationDraftUserInput = generatedForInput`
- `evaluationDraftOutput = generatedOutput`
- `evaluationDraftSeedUserInput = generatedForInput`
- `evaluationDraftSeedOutput = generatedOutput`
- `hasPendingGeneratedDraft = false`

## 12.3 `入力をクリア`

動作:

- `evaluationDraftUserInput = ""`
- `evaluationDraftOutput = ""`
- `evaluationDraftSeedUserInput = ""`
- `evaluationDraftSeedOutput = ""`
- `requestError = ""`

## 12.4 `評価する`

送信値:

- `userInput = evaluationDraftUserInput.trim()`
- `generatedOutput = evaluationDraftOutput.trim()`
- `sourceType = derivedSourceType`
- `domain = selectedDomain`

必須条件:

- 両方とも空でない

バリデーション文言は、現行 `JudgeRequestSchema` ベースを維持する。

## 13. 文言変更方針

評価専用を含むように、評価タブの文言を以下へ寄せる。

変更前の問題:

- `生成画面でまず〜を生成してください`
- `生成結果への人間スコア`
- `前回の生成結果を表示`

変更後の方向:

- `評価対象の文章を入力するか、生成結果を読み込んでください`
- `評価対象の文章への人間スコア`
- `前回評価した文章を表示`

生成前提の固定文言を減らす。

## 14. 実装順序

1. 契約と型を追加する
2. `DomainSessionState` に評価ドラフト関連フィールドを追加する
3. 評価タブ UI を textarea ベースへ変更する
4. Judge / Human Feedback の送信値をドラフトベースへ変更する
5. ログ保存と Weave 連携へ `sourceType` を通す
6. 改善データローダーで `sourceType` フィルタを追加する
7. テストを更新する

## 14.1 主な変更対象ファイル

- `app/components/tabs/EvaluateTabContent.tsx`
  - 評価ドラフト UI、stale 判定、送信値切替
- `app/components/tabs/GenerateTab.tsx`
  - 生成成功時の評価ドラフト同期制御
- `lib/ui/domainSession.ts`
  - 評価ドラフト状態の追加
- `lib/contracts/generateEvaluate.ts`
  - `EvaluationSourceTypeSchema` と関連契約の追加
- `app/api/judge/route.ts`
  - `sourceType` の受け取りと保存
- `app/api/human-feedback/route.ts`
  - `sourceType` の受け取りと保存
- `lib/infrastructure/evaluationLogStore.ts`
  - `sourceType` 保存
- `lib/infrastructure/humanFeedbackStore.ts`
  - `sourceType` 保存
- `lib/infrastructure/weave/weaveLogger.ts`
  - Judge / Human Feedback の trace 拡張
- `lib/infrastructure/weave/weaveQuery.ts`
  - `sourceType` 取得と旧ログ互換
- `lib/application/promptOptimization/gepaDataLoader.ts`
  - target 改善向けの `sourceType` フィルタ
- `tests/api/judge.route.test.ts`
  - `sourceType` 契約の追加ケース
- `tests/api/human-feedback.route.test.ts`
  - `sourceType` 契約の追加ケース
- `tests/ui/domainSessionState.test.ts`
  - ドラフト状態の追加ケース

## 15. テスト方針

## 15.1 UI / state

- `DomainSessionState` 初期値にドラフト系フィールドが入る
- 生成成功時にドラフト自動同期される条件
- 編集済みドラフトが生成成功で上書きされないこと
- ドラフト変更後に `currentResult` が stale 扱いになること

## 15.2 API

- `/api/judge` が `sourceType=manual` を受け付ける
- `/api/human-feedback` が `sourceType=generated_edited` を受け付ける
- `sourceType` 未指定でも後方互換で成功する

## 15.3 ログ / 改善

- `evaluationLogStore` / `humanFeedbackStore` へ `sourceType` が保存される
- Weave 変換で `sourceType` 不在時に `generated` へフォールバックする
- 生成プロンプト改善で `manual` / `generated_edited` が除外される

## 16. 想定リスク

### リスク 1: 評価結果の stale 表示

ドラフト編集中に前回評価結果が残るため、誤読の可能性がある。

対策:

- stale 警告を常時表示する
- 手動評価送信を無効化する

### リスク 2: 手入力データの誤学習

手入力や編集済み文章を target 改善に使うと、改善方向が壊れる。

対策:

- `sourceType` で厳格に除外する

### リスク 3: 新しい生成結果と評価ドラフトの競合

評価中に生成し直した場合、ドラフトをどちらとして扱うか曖昧になる。

対策:

- 自動上書きしない
- `hasPendingGeneratedDraft` で明示する

## 17. セルフレビュー

## 17.1 良い点

- 既存タブ構成を維持できる
- API 破壊的変更なしで導入できる
- `sourceType` により、Judge 改善と Target 改善でデータ利用方針を分けられる
- UI の主変更は評価タブに閉じるため、影響範囲が読みやすい

## 17.2 不足しやすい点

### a. `manual` の定義が広い

完全手入力と外部生成貼り付けが同じ `manual` になる。

評価:

- 初回実装では問題ない
- 将来的に分析粒度が必要なら `manual_paste` / `manual_typed` へ分割余地あり

### b. 元入力なし評価は未対応

要約だけ与えて評価したい要望には応えられない。

評価:

- 現行 Judge の前提から見て妥当
- ここを無理に許可すると評価品質がぶれる

### c. `generated_edited` を Judge 改善へ含める妥当性

人手で整えた文章は、Judge が高得点を付けやすくなる可能性がある。

評価:

- Judge 改善の目的は人間評価との整合なので初期方針としては許容
- ただし、改善結果の偏りが見えた場合は `generated` のみへ絞る切り替え余地を残すべき

### d. セッション状態がやや肥大化する

`DomainSessionState` にフィールドが増える。

評価:

- 今回は最小変更優先で許容
- もし今後も評価用状態が増えるなら、その時点で `generationState` / `evaluationState` 分離を検討する

## 17.3 設計上の修正判断

セルフレビュー後も、今回の実装方針は維持してよいと判断する。

ただし実装時には次の 2 点を必須とする。

1. `stale な評価結果` を UI 上で明確に扱うこと
2. `sourceType` による target 改善データ除外を同一 PR で入れること

この 2 点がないと、UI 誤解と学習データ汚染の両方が残る。
