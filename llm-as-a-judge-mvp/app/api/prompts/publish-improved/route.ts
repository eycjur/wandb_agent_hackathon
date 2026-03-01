/**
 * 改善したプロンプトを Weave に publish する API
 * Judge または Target の改善案を Weave に反映する
 */
import { NextRequest, NextResponse } from "next/server";
import { getWeaveClient } from "@/lib/infrastructure/weave/weaveClient";
import { isWeaveConfigured } from "@/lib/infrastructure/weave/weaveClient";

const VALID_DOMAINS = ["resume_summary", "resume_detail", "self_pr"] as const;
const VALID_TYPES = ["judge", "target"] as const;

export async function POST(request: NextRequest) {
  if (!isWeaveConfigured()) {
    return NextResponse.json(
      { error: { code: "WEAVE_NOT_CONFIGURED", message: "WANDB_API_KEY が設定されていません。" } },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_JSON", message: "JSON形式が不正です。" } },
      { status: 400 }
    );
  }

  const domain =
    typeof body === "object" && body !== null && "domain" in body
      ? (body as { domain: string }).domain
      : undefined;
  const type =
    typeof body === "object" && body !== null && "type" in body
      ? (body as { type: string }).type
      : undefined;
  const promptContent =
    typeof body === "object" && body !== null && "promptContent" in body
      ? (body as { promptContent: string }).promptContent
      : undefined;

  if (
    !domain ||
    !VALID_DOMAINS.includes(domain as (typeof VALID_DOMAINS)[number]) ||
    !type ||
    !VALID_TYPES.includes(type as (typeof VALID_TYPES)[number]) ||
    !promptContent ||
    typeof promptContent !== "string" ||
    promptContent.trim().length === 0
  ) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "domain, type (judge|target), promptContent が必須です。"
        }
      },
      { status: 400 }
    );
  }

  try {
    const client = await getWeaveClient();
    if (!client) {
      return NextResponse.json(
        { error: { code: "WEAVE_NOT_CONFIGURED", message: "Weave クライアントの初期化に失敗しました。" } },
        { status: 500 }
      );
    }

    const weave = await import(/* @vite-ignore */ "weave");
    const StringPrompt = weave.StringPrompt as new (params: {
      content: string;
      name?: string;
      description?: string;
    }) => { content: string };

    // 同じ名前で publish すると Weave がバージョンを自動付与（v0, v1, ...）
    const name = type === "judge" ? `prompt-${domain}-judge` : `prompt-${domain}-target`;
    const description =
      type === "judge"
        ? `Judge プロンプト (${domain})`
        : `生成プロンプト (${domain})`;

    const prompt = new StringPrompt({
      content: promptContent.trim(),
      name,
      description
    });
    await client.publish(prompt, name);

    return NextResponse.json({
      ok: true,
      message: `${type === "judge" ? "Judge" : "生成"}プロンプトを Weave に publish しました（同じ名前でバージョン更新）。次回以降は最新版が自動で使われます。`
    });
  } catch (error) {
    console.error("[/api/prompts/publish-improved] error:", error);
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Weave への publish に失敗しました。" } },
      { status: 500 }
    );
  }
}
