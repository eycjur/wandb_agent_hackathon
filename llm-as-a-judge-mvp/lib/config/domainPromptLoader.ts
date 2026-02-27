import "server-only";

import { parse } from "yaml";
import { z } from "zod";
import { AppError } from "@/lib/errors";

// ビルド時にバンドル（Vercel等サーバーレスでreadFileが失敗するため）
import resumeSummaryYaml from "@/prompts/resume_summary.yml";
import resumeDetailYaml from "@/prompts/resume_detail.yml";
import selfPrYaml from "@/prompts/self_pr.yml";
import sampleYaml from "@/samples/resume_inputs.yml";

export type DomainId = "resume_summary" | "resume_detail" | "self_pr";

const SampleSchema = z.object({
  title: z.string().min(1),
  input: z.string().min(1)
});

const SampleFileSchema = z.object({
  samples: z.array(SampleSchema).min(1)
});

const DomainPromptFileSchema = z.object({
  domain: z.enum(["resume_summary", "resume_detail", "self_pr"]),
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

export type DomainPromptConfig = {
  domain: DomainId;
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

const PROMPT_YAML_MAP: Record<DomainId, string> = {
  resume_summary: resumeSummaryYaml,
  resume_detail: resumeDetailYaml,
  self_pr: selfPrYaml
};

const cache = new Map<DomainId, DomainPromptConfig>();

export async function getDomainPromptConfig(
  domain: DomainId
): Promise<DomainPromptConfig> {
  const cached = cache.get(domain);
  if (cached) {
    return cached;
  }

  const promptYaml = PROMPT_YAML_MAP[domain];

  let parsedYaml: unknown;
  try {
    parsedYaml = parse(promptYaml);
  } catch {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "ドメインプロンプト定義ファイルの解析に失敗しました。",
      `Failed to parse prompt file for domain: ${domain}`
    );
  }

  const validation = DomainPromptFileSchema.safeParse(parsedYaml);
  if (!validation.success) {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "ドメインプロンプト定義ファイルの形式が不正です。",
      `Invalid prompt schema: ${validation.error.message}`
    );
  }

  if (validation.data.domain !== domain) {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "ドメインプロンプト定義のドメインが一致しません。",
      `Domain mismatch: expected ${domain}, got ${validation.data.domain}`
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

  const config: DomainPromptConfig = {
    domain: validation.data.domain as DomainId,
    rubricVersion: validation.data.rubric_version,
    passThreshold: validation.data.pass_threshold,
    targetInstruction: validation.data.target.instruction_template.trim(),
    judgeInstruction,
    judgeRubric: validation.data.judge.rubric,
    samples: sampleValidation.data.samples
  };

  cache.set(domain, config);
  return config;
}

export const SUPPORTED_DOMAINS: DomainId[] = [
  "resume_summary",
  "resume_detail",
  "self_pr"
];
