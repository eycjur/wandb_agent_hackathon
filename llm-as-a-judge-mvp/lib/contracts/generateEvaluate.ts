import { z } from "zod";
import {
  MAX_GENERATED_OUTPUT_CHARS,
  MAX_USER_INPUT_CHARS
} from "@/lib/config/app";
import { SUPPORTED_DOMAINS } from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";

export const DomainIdSchema = z.enum(
  SUPPORTED_DOMAINS as [DomainId, ...DomainId[]]
);

export const LLMProviderSchema = z.enum(["ax", "gemini"]);
export type LLMProviderId = z.infer<typeof LLMProviderSchema>;

export const AxMethodSchema = z.enum(["signature", "few-shot", "gepa"]);
export type AxMethodId = z.infer<typeof AxMethodSchema>;

export const ErrorCodeSchema = z.enum([
  "INVALID_JSON",
  "VALIDATION_ERROR",
  "CONFIG_ERROR",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RESPONSE_INVALID",
  "PROVIDER_ERROR",
  "INTERNAL_ERROR"
]);

export const GenerateEvaluateRequestSchema = z.object({
  userInput: z
    .string()
    .trim()
    .min(1, "職務経歴入力は必須です。")
    .max(MAX_USER_INPUT_CHARS, `職務経歴入力は${MAX_USER_INPUT_CHARS}文字以内で入力してください。`),
  domain: DomainIdSchema.optional().default("resume_summary"),
  llmProvider: LLMProviderSchema.optional().default("ax"),
  axMethod: AxMethodSchema.optional().default("few-shot")
});

export const GenerateRequestSchema = z.object({
  userInput: z
    .string()
    .trim()
    .min(1, "職務経歴入力は必須です。")
    .max(MAX_USER_INPUT_CHARS, `職務経歴入力は${MAX_USER_INPUT_CHARS}文字以内で入力してください。`),
  domain: DomainIdSchema.optional().default("resume_summary"),
  llmProvider: LLMProviderSchema.optional().default("ax"),
  axMethod: AxMethodSchema.optional().default("few-shot")
});

export const GenerateSuccessResponseSchema = z.object({
  generatedOutput: z
    .string()
    .min(1)
    .max(
      MAX_GENERATED_OUTPUT_CHARS,
      `生成要約は${MAX_GENERATED_OUTPUT_CHARS}文字以内で入力してください。`
    )
});

export const JudgeRequestSchema = z.object({
  userInput: z
    .string()
    .trim()
    .min(1, "職務経歴入力は必須です。")
    .max(MAX_USER_INPUT_CHARS, `職務経歴入力は${MAX_USER_INPUT_CHARS}文字以内で入力してください。`),
  generatedOutput: z
    .string()
    .trim()
    .min(1, "生成出力は必須です。")
    .max(
      MAX_GENERATED_OUTPUT_CHARS,
      `生成出力は${MAX_GENERATED_OUTPUT_CHARS}文字以内で入力してください。`
    ),
  domain: DomainIdSchema.optional().default("resume_summary"),
  llmProvider: LLMProviderSchema.optional().default("ax"),
  axMethod: AxMethodSchema.optional().default("few-shot")
});

export const JudgeSuccessResponseSchema = z.object({
  domain: DomainIdSchema,
  rubricVersion: z.number().int().positive(),
  passThreshold: z.number().int().min(0).max(5),
  pass: z.boolean(),
  score: z.number().int().min(0).max(5),
  reason: z.string().min(1)
});

export const GenerateEvaluateSuccessResponseSchema = z.object({
  domain: DomainIdSchema,
  rubricVersion: z.number().int().positive(),
  passThreshold: z.number().int().min(0).max(5),
  pass: z.boolean(),
  generatedOutput: z.string(),
  score: z.number().int().min(0).max(5),
  reason: z.string().min(1)
});

export const GenerateEvaluateErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string()
  })
});

export const DomainSampleSchema = z.object({
  title: z.string().min(1),
  input: z.string().min(1)
});

export const DomainConfigResponseSchema = z.object({
  domain: DomainIdSchema,
  rubricVersion: z.number().int().positive(),
  passThreshold: z.number().int().min(0).max(5),
  samples: z.array(DomainSampleSchema).min(1)
});

export const DomainsListResponseSchema = z.object({
  domains: z.array(
    z.object({
      id: DomainIdSchema,
      label: z.string()
    })
  )
});

// 人間評価
export const HumanFeedbackRequestSchema = z.object({
  domain: DomainIdSchema,
  userInput: z.string().min(1),
  generatedOutput: z.string().min(1),
  judgeResult: z
    .object({
      score: z.number().int().min(0).max(5),
      reason: z.string().min(1),
      pass: z.boolean()
    })
    .optional(),
  humanScore: z.number().int().min(0).max(5),
  humanComment: z.string().optional()
});

export const HumanFeedbackRecordSchema = z.object({
  id: z.string(),
  domain: DomainIdSchema,
  userInput: z.string(),
  generatedOutput: z.string(),
  judgeResult: z
    .object({
      score: z.number(),
      reason: z.string(),
      pass: z.boolean()
    })
    .optional(),
  humanScore: z.number(),
  humanComment: z.string().optional(),
  createdAt: z.string()
});

export const HumanFeedbackListResponseSchema = z.object({
  records: z.array(HumanFeedbackRecordSchema)
});

export const WandbStatusResponseSchema = z.object({
  configured: z.boolean()
});

export const WandbDashboardResponseSchema = WandbStatusResponseSchema.extend({
  dashboardUrl: z.union([z.string().url(), z.null()])
});

// Judge プロンプト改善
export const JudgePromptImproveRequestSchema = z.object({
  domain: DomainIdSchema,
  feedbackLimit: z.number().int().min(1).max(50).optional().default(10),
  llmProvider: LLMProviderSchema.optional().default("ax"),
  axMethod: AxMethodSchema.optional().default("few-shot")
});

export const JudgePromptImproveResponseSchema = z.object({
  suggestion: z.string(),
  analysisSummary: z.string(),
  currentPrompt: z.string().optional(),
  resultSource: z.enum(["gepa", "fallback", "standard"]),
  degradedReason: z.string().optional()
});

// 生成プロンプト改善
export const TargetPromptImproveRequestSchema = z.object({
  domain: DomainIdSchema,
  failedLimit: z.number().int().min(1).max(50).optional().default(10),
  minScore: z.number().int().min(0).max(5).optional(),
  llmProvider: LLMProviderSchema.optional().default("ax"),
  axMethod: AxMethodSchema.optional().default("few-shot")
});

export const TargetPromptImproveResponseSchema = z.object({
  suggestion: z.string(),
  analysisSummary: z.string(),
  resultSource: z.enum(["gepa", "fallback", "standard"]),
  degradedReason: z.string().optional()
});

// GEPA 非同期ジョブ
export const GepaJobKindSchema = z.enum(["judge", "target"]);
export type GepaJobKind = z.infer<typeof GepaJobKindSchema>;

export const GepaJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "canceled"]);
export type GepaJobStatus = z.infer<typeof GepaJobStatusSchema>;

export const GepaJobEnqueueRequestSchema = z.object({
  kind: GepaJobKindSchema,
  domain: DomainIdSchema,
  feedbackLimit: z.number().int().min(1).max(50).optional().default(10),
  failedLimit: z.number().int().min(1).max(50).optional().default(10),
  minScore: z.number().int().min(0).max(5).optional(),
  llmProvider: LLMProviderSchema.optional().default("ax"),
  axMethod: AxMethodSchema.optional().default("gepa")
});

export const GepaJobEnqueueResponseSchema = z.object({
  jobId: z.string().min(1),
  kind: GepaJobKindSchema,
  domain: DomainIdSchema,
  status: GepaJobStatusSchema
});

export const GepaJobStatusResponseSchema = z.object({
  jobId: z.string().min(1),
  kind: GepaJobKindSchema,
  domain: DomainIdSchema,
  status: GepaJobStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  result: z
    .object({
      suggestion: z.string(),
      analysisSummary: z.string(),
      currentPrompt: z.string().optional(),
      resultSource: z.enum(["gepa", "fallback", "standard"]).optional(),
      degradedReason: z.string().optional()
    })
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string()
    })
    .optional()
});

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type GenerateEvaluateRequest = z.infer<typeof GenerateEvaluateRequestSchema>;
export type GenerateEvaluateSuccessResponse = z.infer<
  typeof GenerateEvaluateSuccessResponseSchema
>;
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
export type GenerateSuccessResponse = z.infer<typeof GenerateSuccessResponseSchema>;
export type JudgeRequest = z.infer<typeof JudgeRequestSchema>;
export type JudgeSuccessResponse = z.infer<typeof JudgeSuccessResponseSchema>;
export type GenerateEvaluateErrorResponse = z.infer<
  typeof GenerateEvaluateErrorResponseSchema
>;
export type DomainConfigResponse = z.infer<typeof DomainConfigResponseSchema>;
export type DomainsListResponse = z.infer<typeof DomainsListResponseSchema>;
export type HumanFeedbackRequest = z.infer<typeof HumanFeedbackRequestSchema>;
export type HumanFeedbackRecord = z.infer<typeof HumanFeedbackRecordSchema>;
export type HumanFeedbackListResponse = z.infer<typeof HumanFeedbackListResponseSchema>;
export type JudgePromptImproveRequest = z.infer<typeof JudgePromptImproveRequestSchema>;
export type JudgePromptImproveResponse = z.infer<typeof JudgePromptImproveResponseSchema>;
export type TargetPromptImproveRequest = z.infer<typeof TargetPromptImproveRequestSchema>;
export type TargetPromptImproveResponse = z.infer<typeof TargetPromptImproveResponseSchema>;
export type GepaJobEnqueueRequest = z.infer<typeof GepaJobEnqueueRequestSchema>;
export type GepaJobEnqueueResponse = z.infer<typeof GepaJobEnqueueResponseSchema>;
export type GepaJobStatusResponse = z.infer<typeof GepaJobStatusResponseSchema>;
