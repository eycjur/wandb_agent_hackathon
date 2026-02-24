import { z } from "zod";
import {
  MAX_GENERATED_OUTPUT_CHARS,
  MAX_USER_INPUT_CHARS
} from "@/lib/config/app";

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
    .max(MAX_USER_INPUT_CHARS, `職務経歴入力は${MAX_USER_INPUT_CHARS}文字以内で入力してください。`)
});

export const GenerateRequestSchema = GenerateEvaluateRequestSchema;

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
    .min(1, "生成要約は必須です。")
    .max(
      MAX_GENERATED_OUTPUT_CHARS,
      `生成要約は${MAX_GENERATED_OUTPUT_CHARS}文字以内で入力してください。`
    )
});

export const JudgeSuccessResponseSchema = z.object({
  domain: z.literal("resume_summary"),
  rubricVersion: z.number().int().positive(),
  passThreshold: z.number().int().min(0).max(5),
  pass: z.boolean(),
  score: z.number().int().min(0).max(5),
  reason: z.string().min(1)
});

export const GenerateEvaluateSuccessResponseSchema = z.object({
  domain: z.literal("resume_summary"),
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
  domain: z.literal("resume_summary"),
  rubricVersion: z.number().int().positive(),
  passThreshold: z.number().int().min(0).max(5),
  samples: z.array(DomainSampleSchema).min(1)
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
