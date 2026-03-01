import type { DomainId } from "@/lib/config/domainPromptLoader";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import { generateTextForPromptImprovement } from "@/lib/infrastructure/promptImproveGenerator";
import { optimizeJudgePromptWithGEPA } from "@/lib/infrastructure/ax/axGepaOptimizer";
import type { HumanFeedbackRecord } from "@/lib/infrastructure/humanFeedbackStore";
import type {
  AxMethodId,
  LLMProviderId,
} from "@/lib/contracts/generateEvaluate";
import { getWeaveProjectId } from "@/lib/infrastructure/weave/weaveProjectId";
import { AppError } from "@/lib/errors";

export interface JudgePromptImprovementResult {
  suggestion: string;
  analysisSummary: string;
  currentPrompt?: string;
}

export type JudgePromptImproveOptions = {
  llmProvider?: LLMProviderId;
  axMethod?: AxMethodId;
};

/**
 * 人間評価に基づいて Judge プロンプトの改善案を LLM で生成する
 * 乖離が大きいケース（Judge と人間のスコア差が 2 以上）を優先的に分析
 */
export async function generateJudgePromptImprovement(
  feedbackRecords: HumanFeedbackRecord[],
  domain: DomainId,
  options: JudgePromptImproveOptions = {},
): Promise<JudgePromptImprovementResult> {
  const withJudgeResult = feedbackRecords.filter((r) => r.judgeResult != null);
  const promptConfig = await getDomainPromptConfig(domain);

  if (withJudgeResult.length === 0) {
    return {
      suggestion:
        "Judge 評価済みの人間評価データがありません。自動評価を実行したうえで人間評価を蓄積してから再度お試しください。",
      analysisSummary: "分析対象なし",
      currentPrompt: promptConfig.judgeInstruction,
    };
  }

  if (options.llmProvider === "ax" && options.axMethod === "gepa") {
    const gepaResult = await optimizeJudgePromptWithGEPA(
      feedbackRecords,
      domain,
    );
    return { ...gepaResult, currentPrompt: promptConfig.judgeInstruction };
  }

  // gemini → W&B MCP Server 経由で Gemini が Weave データを自律取得
  if (options.llmProvider === "gemini") {
    if (!process.env.WANDB_API_KEY) {
      throw new AppError(
        500,
        "CONFIG_ERROR",
        "サーバー設定エラーが発生しました。",
        "Gemini プロバイダを利用するには WANDB_API_KEY 環境変数を設定してください。",
      );
    }
    const projectId = await getWeaveProjectId();
    if (!projectId) {
      throw new AppError(
        500,
        "CONFIG_ERROR",
        "サーバー設定エラーが発生しました。",
        "Could not resolve W&B project ID. Set WANDB_ENTITY and WANDB_PROJECT env vars.",
      );
    }
    const mcpPrompt = buildMcpPrompt(domain, projectId, promptConfig);
    const rawResponse = await generateTextForPromptImprovement(mcpPrompt, {
      llmProvider: "gemini",
    });
    const analysisMatch = rawResponse.match(
      /【分析サマリー】\s*([\s\S]*?)(?=【改善案】|$)/,
    );
    const suggestionMatch = rawResponse.match(/【改善案】\s*([\s\S]*?)$/);
    return {
      suggestion: suggestionMatch?.[1]?.trim() ?? rawResponse,
      analysisSummary:
        analysisMatch?.[1]?.trim() ?? "分析結果を抽出できませんでした",
      currentPrompt: promptConfig.judgeInstruction,
    };
  }

  // 乖離が大きいケースを優先（スコア差が2以上）
  const withDiscrepancy = withJudgeResult
    .map((r) => ({
      ...r,
      scoreDiff: Math.abs(
        r.humanScore - (r.judgeResult?.score ?? r.humanScore),
      ),
    }))
    .filter((r) => r.scoreDiff >= 2)
    .sort((a, b) => b.scoreDiff - a.scoreDiff);

  const recordsToAnalyze =
    withDiscrepancy.length >= 3
      ? withDiscrepancy.slice(0, 5)
      : withJudgeResult.slice(0, 5);

  const examplesText = recordsToAnalyze
    .map(
      (r, i) =>
        `【例${i + 1}】
- 生成出力: ${r.generatedOutput.slice(0, 300)}${r.generatedOutput.length > 300 ? "..." : ""}
- Judge 評価: スコア ${r.judgeResult!.score}, 理由: ${r.judgeResult!.reason}
- 人間評価: スコア ${r.humanScore}${r.humanComment ? `, コメント: ${r.humanComment}` : ""}`,
    )
    .join("\n\n");

  const prompt = `あなたは LLM の評価プロンプト（Judge）を改善する専門家です。

以下の「現在の Judge プロンプト」と「人間評価との乖離があるケース」を分析し、
Judge の評価が人間の感覚に近づくための改善案を提案してください。

## 現在の Judge プロンプト（instruction_template）

${promptConfig.judgeInstruction}

## 現在のルーブリック

${promptConfig.judgeRubric.map((r) => `- ${r}`).join("\n")}

## 人間評価との乖離があるケース

${examplesText}

## 出力形式

以下の形式で回答してください。改善案は具体的に、YAML の judge.instruction_template にそのまま反映できる形で書いてください。

【分析サマリー】
（乖離のパターンや原因を2〜3文で）

【改善案】
（judge.instruction_template の改善版テキスト。コードブロックは使わず、そのままコピペできる形で）`;

  const rawResponse = await generateTextForPromptImprovement(prompt, {
    llmProvider: options.llmProvider,
    axMethod: options.axMethod,
  });

  // 【分析サマリー】と【改善案】をパース
  const analysisMatch = rawResponse.match(
    /【分析サマリー】\s*([\s\S]*?)(?=【改善案】|$)/,
  );
  const suggestionMatch = rawResponse.match(/【改善案】\s*([\s\S]*?)$/);

  const analysisSummary =
    analysisMatch?.[1]?.trim() ?? "分析結果を抽出できませんでした";
  const suggestion = suggestionMatch?.[1]?.trim() ?? rawResponse;

  return {
    suggestion,
    analysisSummary,
    currentPrompt: promptConfig.judgeInstruction,
  };
}

/**
 * W&B MCP Server 経由で Gemini が Weave データを自律取得するためのプロンプトを構築する。
 * データをプロンプトに埋め込む代わりに、MCP ツールでの取得を指示する。
 */
function buildMcpPrompt(
  domain: DomainId,
  projectId: string,
  promptConfig: Awaited<ReturnType<typeof getDomainPromptConfig>>,
): string {
  return `あなたは LLM の評価プロンプト（Judge）を改善する専門家です。Judgeプロンプトを多数改善した経験があり、LLMの評価傾向と人間の感覚の乖離を体系的に分析することが得意です。
W&B Weave に保存された評価データを MCP ツールで取得・分析し、Judge プロンプトの改善案を提案してください。

## 対象プロジェクト
W&B プロジェクト: **${projectId}**

## 分析手順
1. \`query_weave_traces_tool\` を使い、op_name に "human_feedback_log" を含むトレースを取得する。
   取得されたデータのうち、 "humanScore" と "humanComment" を「人間の評価」、 "judgeScore" と "judgeResult.reason" を「LLMの評価」と呼ぶ。
2. domain が "${domain}" のデータに絞り込む
3. 取得したデータのスコア差の分布（最小・最大・平均・中央値）やhumanComment, judgeResult.reasonを確認し、データの実態に基づいて「乖離」とみなす基準を自身で設定する。その基準と選定理由を分析サマリーに明記する。
5. 設定した乖離基準を満たすケースを抽出する。過大評価（LLM > 人間）と過小評価（LLM < 人間）が偏らないよう代表的なサンプルを選ぶ（最大20件）。
6. 抽出したケースを以下の観点で分類・分析する:
   - Judge が過大評価するパターン（どんな出力特徴が高スコアを引き起こすか）
   - Judge が過小評価するパターン（どんな出力特徴が低スコアを引き起こすか）
   - 文体・表現への依存（内容ではなく言い回しでスコアが変わるケース）
   - ルーブリックの特定項目への偏重（一部観点だけで総合判断している疑い）
7. 分析結果をもとに、現在の Judge プロンプトの問題箇所を特定し、改善アクションを導出する
8. 改善アクションを反映した改善案を1つ生成する

## 現在の Judge プロンプト（instruction_template）

${promptConfig.judgeInstruction}

## 現在のルーブリック

${promptConfig.judgeRubric.map((r) => `- ${r}`).join("\n")}

## 出力形式

以下の形式で回答してください。改善案は具体的に、YAML の judge.instruction_template にそのまま反映できる形で書いてください。
何らかの原因で分析サマリーと改善案を回答できない場合は、分析サマリーに理由を書いて、改善案には instruction_template をそのまま出力してください。

【分析サマリー】
（乖離基準とその設定根拠、観点別の乖離パターンを複数列挙して分析する。Judge プロンプトのどの部分が原因かも特定する）

【改善案】
（judge.instruction_template の改善版テキスト。コードブロックは使わず、そのままコピペできる形で）`;
}
