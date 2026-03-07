/**
 * 人間評価と Judge 評価の差があるとき、LLM で観点の指針を生成する
 */
import { GoogleGenAI } from "@google/genai";
import { AppError } from "@/lib/errors";
import { GEPA_MODEL } from "@/lib/config/llm";

export type EvaluationGuidanceInput = {
  humanScore: number;
  humanComment?: string;
  predScore: number;
  predReason: string;
  rubricItems: string[];
};

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_APIKEY;
  if (!apiKey) {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "サーバー設定エラーが発生しました。",
      "GEMINI_API_KEY or GOOGLE_APIKEY is not set."
    );
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * 人間評価と Judge 評価の差があるとき、どの観点を重視・軽視すべきかの指針を LLM で生成する
 */
export async function generateEvaluationGuidance(
  input: EvaluationGuidanceInput
): Promise<string> {
  const { humanScore, humanComment, predScore, predReason, rubricItems } = input;
  const rubricText = rubricItems.length > 0 ? rubricItems.map((r) => `- ${r}`).join("\n") : "(なし)";

  const prompt = `あなたは評価基準の整合性を高めるエキスパートです。

【状況】
- 人間の評価: スコア ${humanScore}/5、コメント: ${humanComment ?? "(なし)"}
- Judge（自動評価）の評価: スコア ${predScore}/5、理由: ${predReason || "(なし)"}
- ルーブリック観点: 
${rubricText}

人間の評価に合わせるため、Judge プロンプトに追加すべき具体的な採点ルールを書いてください。
以下の形式で、直接的に採点に反映できる形で示してください。

例:
- 「〇〇の場合は4点以上と評価する」
- 「△△が含まれていれば1点加算する」
- 「□□の欠如で2点減点する」
- 「××のときは3点とする」

1〜3個の具体的なルールを、上記のような形式で書いてください。日本語で回答。`;

  const ai = getClient();
  try {
    const response = await ai.models.generateContent({
      model: GEPA_MODEL,
      contents: prompt,
      config: { temperature: 0.3 }
    });
    const text = response.text?.trim();
    return text && text.length > 0 ? text : "人間のコメントに基づき、採点ルール（〇〇の場合はY点、△△でZ点減点など）を具体的に追加してください。";
  } catch (error) {
    console.warn("[evaluationGuidance] LLM failed:", error);
    return `人間(${humanScore})とJudge(${predScore})で差あり。人間のコメント「${(humanComment ?? "").slice(0, 60)}」を参考に、採点ルール（〇〇の場合はY点など）を具体的に追加してください。`;
  }
}
