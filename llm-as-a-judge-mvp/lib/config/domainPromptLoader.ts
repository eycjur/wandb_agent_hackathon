import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { AppError } from "@/lib/errors";

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

const DOMAIN_FILE_MAP: Record<DomainId, string> = {
  resume_summary: "resume_summary.yml",
  resume_detail: "resume_detail.yml",
  self_pr: "self_pr.yml"
};

const cache = new Map<DomainId, DomainPromptConfig>();

export async function getDomainPromptConfig(
  domain: DomainId
): Promise<DomainPromptConfig> {
  const cached = cache.get(domain);
  if (cached) {
    return cached;
  }

  const fileName = DOMAIN_FILE_MAP[domain];
  const promptPath = path.join(process.cwd(), "prompts", fileName);

  let fileText: string;
  try {
    fileText = await readFile(promptPath, "utf8");
  } catch {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "ドメインプロンプト定義ファイルの読み込みに失敗しました。",
      `Failed to read prompt file: ${promptPath}`
    );
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parse(fileText);
  } catch {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "ドメインプロンプト定義ファイルの解析に失敗しました。",
      `Failed to parse prompt file: ${promptPath}`
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

  const samplePath = path.isAbsolute(validation.data.samples_path)
    ? validation.data.samples_path
    : path.join(process.cwd(), validation.data.samples_path);

  let sampleText: string;
  try {
    sampleText = await readFile(samplePath, "utf8");
  } catch {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "サンプル入力ファイルの読み込みに失敗しました。",
      `Failed to read sample file: ${samplePath}`
    );
  }

  let sampleYaml: unknown;
  try {
    sampleYaml = parse(sampleText);
  } catch {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "サンプル入力ファイルの解析に失敗しました。",
      `Failed to parse sample file: ${samplePath}`
    );
  }

  const sampleValidation = SampleFileSchema.safeParse(sampleYaml);
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
