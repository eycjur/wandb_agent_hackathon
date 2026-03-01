/**
 * Weave プロンプト管理
 * プロンプトを Weave に publish し、バージョン管理・可視化を可能にする。
 * 同じ名前で publish するとバージョンが自動付与され、:latest で最新を取得できる。
 *
 * WANDB_API_KEY が設定され、weave パッケージがインストールされている場合に動作。
 * 認証: WANDB_API_KEY または ~/.netrc に api.wandb.ai の認証情報を設定
 */

import { getWeaveClient } from "./weaveClient";
import { getWeaveProjectId } from "./weaveProjectId";

export type PromptConfigForWeave = {
  domain: string;
  rubricVersion: number;
  targetInstruction: string;
  judgeInstruction: string;
};

type StringPromptClass = new (params: { content: string; name?: string; description?: string }) => {
  content: string;
};

export function isWeavePromptConfigured(): boolean {
  return Boolean(process.env.WANDB_API_KEY);
}

/** Weave からプロンプトを取得（:latest）。失敗時は null */
export async function fetchPromptFromWeave(
  domain: string,
  type: "judge" | "target"
): Promise<string | null> {
  const client = await getWeaveClient();
  if (!client) return null;
  const projectId = await getWeaveProjectId();
  if (!projectId) return null;
  try {
    const weave = await import(/* @vite-ignore */ "weave") as { ObjectRef?: { fromUri: (uri: string) => unknown } };
    if (!weave.ObjectRef?.fromUri) return null;
    const name = type === "judge" ? `prompt-${domain}-judge` : `prompt-${domain}-target`;
    const uri = `weave:///${projectId}/object/${name}:latest`;
    const ref = weave.ObjectRef.fromUri(uri);
    const prompt = await client.get(ref);
    return typeof prompt?.content === "string" ? prompt.content.trim() : null;
  } catch {
    return null;
  }
}

/**
 * ドメインプロンプトを Weave に publish する。
 * 非同期で実行し、失敗しても呼び出し元には影響しない。
 */
export async function publishPromptToWeave(config: PromptConfigForWeave): Promise<void> {
  const client = await getWeaveClient();
  if (!client) return;

  const weave = await import(/* @vite-ignore */ "weave");
  const StringPrompt = weave.StringPrompt as StringPromptClass;

  try {
    const targetPrompt = new StringPrompt({
      content: config.targetInstruction,
      name: `prompt-${config.domain}-target`,
      description: `生成プロンプト (${config.domain}), rubric_version=${config.rubricVersion}`
    });
    await client.publish(targetPrompt, `prompt-${config.domain}-target`);

    const judgePrompt = new StringPrompt({
      content: config.judgeInstruction,
      name: `prompt-${config.domain}-judge`,
      description: `評価プロンプト (${config.domain}), rubric_version=${config.rubricVersion}`
    });
    await client.publish(judgePrompt, `prompt-${config.domain}-judge`);
  } catch (err) {
    console.warn("[weave] publishPromptToWeave failed:", err);
  }
}
