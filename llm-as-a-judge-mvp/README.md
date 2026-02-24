# 職務経歴要約 MVP (Gemini)

## Overview
単一ページで以下を実行する最小実装です。

1. 職務経歴テキストをTarget LLMへ送信して要約を生成
2. 要約結果をJudge LLMで評価
3. Score / Reason / 合格判定を表示

## Tech Stack
- Next.js (App Router, TypeScript)
- Gemini API (`@google/genai`)

## Fixed Model Settings
- Target LLM: `gemini-2.5-flash`
- Judge LLM: `gemini-2.5-pro`

## Prompt Configuration
- ドメイン定義は `/Users/suguru.masui/wandb_agent_hackathon/prompts/resume_summary.yml` に定義
- サンプル入力は `/Users/suguru.masui/wandb_agent_hackathon/samples/resume_inputs.yml` に定義
- サーバー起動中は読み込み結果をメモリキャッシュ
- `judge.instruction_template` 内の `{{RUBRIC_BULLETS}}` を `judge.rubric` から展開

## Architecture
- `app/api/generate/route.ts`: generation endpoint (presentation layer)
- `app/api/judge/route.ts`: judge endpoint (presentation layer)
- `app/api/domain-config/route.ts`: domain config endpoint (presentation layer)
- `app/api/generate-evaluate/route.ts`: legacy combined endpoint (backward compatibility)
- `lib/application/generateAndEvaluateUseCase.ts`: application layer
- `lib/domain/llm.ts`: domain types and provider interface
- `lib/infrastructure/gemini/GeminiProvider.ts`: Gemini provider implementation
- `lib/contracts/generateEvaluate.ts`: shared request/response contract (`zod`)
- `lib/config/resumeSummaryPromptLoader.ts`: domain prompt loader

## UI
- 全体を `生成` / `評価` タブで切り替え
- `生成` タブ: 2カラム構成（職務経歴入力 + 生成要約/Progress）
- `評価` タブ: 「生成要約 / 評価結果」を左右並び表示し、その下にProgressを表示
- Progress表示（Input accepted -> Generating summary -> Summary generated -> Judging summary -> Completed）
- `要約を生成` / `要約を評価` の2ボタンを分離
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

`GET /api/domain-config`

フロントエンドは通常 `要約を生成` で `/api/generate`、続けて `要約を評価` で `/api/judge` を呼び出します。

### Generate Request (`POST /api/generate`)

```json
{
  "userInput": "2019年にSIerへ入社し、金融系Webシステムの保守運用を担当..."
}
```

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
  "generatedOutput": "..."
}
```

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

### Domain Config Response (`GET /api/domain-config`)

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
- 入力すると出力が生成される
- 生成済み要約をLLMが評価できる
- ScoreとReasonが表示される

## Notes
- APIキーはサーバー側でのみ使用
- データ保存なし
- UI操作として `generate` と `judge` は分離
- 内部エラー詳細はクライアントへ露出しない
- モデル呼び出しは20秒でタイムアウト
- API/UIは `zod` スキーマを共有
- resume_summaryドメイン設定はYAMLをサーバー側で読み込む
