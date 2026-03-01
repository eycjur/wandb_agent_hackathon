/**
 * プロンプトを Weave に同期する API
 * 全ドメインの YAML プロンプトを Weave に publish する。
 */
import { NextResponse } from "next/server";
import { getDomainPromptConfig, SUPPORTED_DOMAINS } from "@/lib/config/domainPromptLoader";
import { publishPromptToWeave, isWeavePromptConfigured } from "@/lib/infrastructure/weave/promptManager";

export async function POST() {
  if (!isWeavePromptConfigured()) {
    return NextResponse.json(
      { error: { code: "WEAVE_NOT_CONFIGURED", message: "WANDB_API_KEY が設定されていません。" } },
      { status: 400 }
    );
  }

  try {
    for (const domain of SUPPORTED_DOMAINS) {
      const config = await getDomainPromptConfig(domain);
      await publishPromptToWeave({
        domain: config.domain,
        rubricVersion: config.rubricVersion,
        targetInstruction: config.targetInstruction,
        judgeInstruction: config.judgeInstruction
      });
    }
    return NextResponse.json({ ok: true, message: "全ドメインのプロンプトを Weave に同期しました。" });
  } catch (error) {
    console.error("[/api/prompts/sync-to-weave] error:", error);
    return NextResponse.json(
      { error: { code: "SYNC_FAILED", message: "Weave への同期に失敗しました。" } },
      { status: 500 }
    );
  }
}
