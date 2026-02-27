# 職務経歴書アシスタント MVP (Gemini)

## Overview
単一ページで以下を実行する最小実装です。

1. 職務経歴テキストをTarget LLMへ送信して生成（要約 / 職務経歴詳細 / 自己PR）
2. 生成結果をJudge LLMで評価
3. Score / Reason / 合格判定を表示

### 対応ドメイン
- **職務要約** (`resume_summary`): 採用担当向けの簡潔な要約（3〜6文）
- **職務経歴（詳細）** (`resume_detail`): 構造化された職務経歴（会社・期間・業務・実績の数値化）
- **自己PR** (`self_pr`): 200〜400文字の自己PR文（2〜3個の強み）

## Tech Stack
- Next.js (App Router, TypeScript)
- Gemini API (`@google/genai`)

## Fixed Model Settings
- Target LLM: `gemini-2.5-flash`
- Judge LLM: `gemini-2.5-pro`

## Prompt Configuration
- ドメイン定義は `prompts/*.yml` に定義（resume_summary, resume_detail, self_pr）
- サンプル入力は `samples/resume_inputs.yml` に定義（全ドメイン共通）
- サーバー起動中は読み込み結果をメモリキャッシュ
- `judge.instruction_template` 内の `{{RUBRIC_BULLETS}}` を `judge.rubric` から展開

## Architecture
- `app/api/generate/route.ts`: generation endpoint (presentation layer)
- `app/api/judge/route.ts`: judge endpoint (presentation layer)
- `app/api/domain-config/route.ts`: domain config endpoint (presentation layer)
- `app/api/domains/route.ts`: supported domains list endpoint (presentation layer)
- `app/api/generate-evaluate/route.ts`: legacy combined endpoint (backward compatibility)
- `lib/application/generateAndEvaluateUseCase.ts`: application layer
- `lib/domain/llm.ts`: domain types and provider interface
- `lib/infrastructure/gemini/GeminiProvider.ts`: Gemini provider implementation
- `lib/contracts/generateEvaluate.ts`: shared request/response contract (`zod`)
- `lib/config/domainPromptLoader.ts`: multi-domain prompt loader
- `lib/config/resumeSummaryPromptLoader.ts`: resume_summary wrapper (backward compatibility)

## UI
- 生成モード選択（職務要約 / 職務経歴（詳細） / 自己PR）
- 全体を `生成` / `評価` タブで切り替え
- `生成` タブ: 2カラム構成（職務経歴入力 + 生成出力/Progress）
- `評価` タブ: 「生成出力 / 評価結果」を左右並び表示し、その下にProgressを表示
- Progress表示（Input accepted -> Generating -> Generated -> Judging -> Completed）
- ドメイン別の生成/評価ボタン（要約を生成、職務経歴を生成、自己PRを生成 など）
- `Advanced` の固定設定表示（Provider/Model/Prompt）
- サンプル入力ボタン（YAML由来・2種類）
- 生成要約の`Copy`と`最後の入力で再生成`
- `Download .txt`、`Ctrl/Cmd + Enter`（要約生成）ショートカット
- 入力エラーと実行エラーの分離表示
- 前回結果とのスコア差分表示 + 合格/要改善表示
- 実行中の経過秒表示とスケルトンローディング

## Setup
1. Install dependencies

```bash
npm install
```

2. Set environment variable

```bash
cp .env.example .env.local
# edit .env.local and set GEMINI_API_KEY
```

3. Start dev server

```bash
npm run dev
```

4. Open app

- [http://localhost:3000](http://localhost:3000)

5. Run tests

```bash
npm test
```

## API
`POST /api/generate`

`POST /api/judge`

`GET /api/domain-config?domain=resume_summary`

`GET /api/domains`

フロントエンドは生成モードに応じて `/api/generate` に `domain` を指定し、続けて `/api/judge` を呼び出します。

### Generate Request (`POST /api/generate`)

```json
{
  "userInput": "2019年にSIerへ入社し、金融系Webシステムの保守運用を担当...",
  "domain": "resume_summary"
}
```

- `domain`: 省略時は `resume_summary`。`resume_detail` / `self_pr` も指定可能。

### Generate Response (`POST /api/generate`)

```json
{
  "generatedOutput": "..."
}
```

### Judge Request (`POST /api/judge`)

```json
{
  "userInput": "2019年にSIerへ入社し、金融系Webシステムの保守運用を担当...",
  "generatedOutput": "...",
  "domain": "resume_summary"
}
```

- `domain`: 生成時に使用したドメインを指定。省略時は `resume_summary`。

### Judge Response (`POST /api/judge`)

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

### Error Response

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "message"
  }
}
```

### Domain Config Response (`GET /api/domain-config?domain=resume_summary`)

```json
{
  "domain": "resume_summary",
  "rubricVersion": 1,
  "passThreshold": 4,
  "samples": [
    {
      "title": "Web開発エンジニア",
      "input": "..."
    }
  ]
}
```

- `domain` クエリ: `resume_summary` / `resume_detail` / `self_pr`。省略時は `resume_summary`。

### Domains List Response (`GET /api/domains`)

```json
{
  "domains": [
    { "id": "resume_summary", "label": "職務要約", "promptFile": "prompts/resume_summary.yml" },
    { "id": "resume_detail", "label": "職務経歴（詳細）", "promptFile": "prompts/resume_detail.yml" },
    { "id": "self_pr", "label": "自己PR", "promptFile": "prompts/self_pr.yml" }
  ]
}
```

### Validation
- `userInput`（職務経歴入力）は必須
- `userInput` は 4000 文字以内
- `generatedOutput` は必須
- `generatedOutput` は 12000 文字以内

### Error Codes
- `INVALID_JSON`
- `VALIDATION_ERROR`
- `CONFIG_ERROR`
- `PROVIDER_TIMEOUT`
- `PROVIDER_RESPONSE_INVALID`
- `PROVIDER_ERROR`
- `INTERNAL_ERROR`

## DoD Checkpoints
- 入力すると出力が生成される（職務要約 / 職務経歴詳細 / 自己PR）
- 生成済み出力をLLMが評価できる
- ScoreとReasonが表示される

## Notes
- APIキーはサーバー側でのみ使用
- データ保存なし
- UI操作として `generate` と `judge` は分離
- 内部エラー詳細はクライアントへ露出しない
- モデル呼び出しは20秒でタイムアウト
- API/UIは `zod` スキーマを共有
- 各ドメイン設定はYAMLをサーバー側で読み込む（prompts/*.yml）
