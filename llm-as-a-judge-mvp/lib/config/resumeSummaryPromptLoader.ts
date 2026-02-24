import "server-only";

import { parse } from "yaml";
import { z } from "zod";
import { AppError } from "@/lib/errors";

// ビルド時にバンドル（Vercel等サーバーレスでreadFileが失敗するため）
import promptYaml from "@/prompts/resume_summary.yml";
import sampleYaml from "@/samples/resume_inputs.yml";

const SampleSchema = z.object({
  title: z.string().min(1),
  input: z.string().min(1)
});

const SampleFileSchema = z.object({
  samples: z.array(SampleSchema).min(1)
});

const ResumeSummaryPromptFileSchema = z.object({
  domain: z.literal("resume_summary"),
  rubric_version: z.number().int().positive(),
  pass_threshold: z.number().int().min(0).max(5),
  samples_path: z.string().min(1),
  target: z.object({
    instruction_template: z.string().min(1)
  }),
  judge: z.object({
    rubric: z.array(z.string().min(1)).min(1),
    instruction_template: z.string().min(1)
  })
});

type ResumeSummaryPromptConfig = {
  domain: "resume_summary";
  rubricVersion: number;
  passThreshold: number;
  targetInstruction: string;
  judgeInstruction: string;
  judgeRubric: string[];
  samples: Array<{
    title: string;
    input: string;
  }>;
};

let cachedPrompt: ResumeSummaryPromptConfig | null = null;

export async function getResumeSummaryPromptConfig(): Promise<ResumeSummaryPromptConfig> {
  if (cachedPrompt) {
    return cachedPrompt;
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parse(promptYaml);
  } catch {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "ドメインプロンプト定義ファイルの解析に失敗しました。",
      "Failed to parse prompt file"
    );
  }

  const validation = ResumeSummaryPromptFileSchema.safeParse(parsedYaml);
  if (!validation.success) {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "ドメインプロンプト定義ファイルの形式が不正です。",
      `Invalid prompt schema: ${validation.error.message}`
    );
  }

  const rubricBullets = validation.data.judge.rubric
    .map((item) => `- ${item}`)
    .join("\n");

  let parsedSample: unknown;
  try {
    parsedSample = parse(sampleYaml);
  } catch {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "サンプル入力ファイルの解析に失敗しました。",
      "Failed to parse sample file"
    );
  }

  const sampleValidation = SampleFileSchema.safeParse(parsedSample);
  if (!sampleValidation.success) {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "サンプル入力ファイルの形式が不正です。",
      `Invalid sample schema: ${sampleValidation.error.message}`
    );
  }

  const judgeInstruction = validation.data.judge.instruction_template
    .replace("{{RUBRIC_BULLETS}}", rubricBullets)
    .trim();

  cachedPrompt = {
    domain: validation.data.domain,
    rubricVersion: validation.data.rubric_version,
    passThreshold: validation.data.pass_threshold,
    targetInstruction: validation.data.target.instruction_template.trim(),
    judgeInstruction,
    judgeRubric: validation.data.judge.rubric,
    samples: sampleValidation.data.samples
  };

  return cachedPrompt;
}
