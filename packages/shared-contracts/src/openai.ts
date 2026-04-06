import { z } from "zod";

import { jsonRecordSchema, nonEmptyStringSchema, positiveIntegerSchema } from "./common.js";

export const openAiRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

const openAiDataUrlSchema = nonEmptyStringSchema.refine(
  (value) => value.toLowerCase().startsWith("data:"),
  "A data URL or remote URL is required.",
);

export const openAiImageUrlSchema = z.object({
  url: z.union([z.string().url(), openAiDataUrlSchema]),
  detail: z.enum(["auto", "low", "high"]).optional(),
});

export const openAiTextContentPartSchema = z.object({
  type: z.literal("text"),
  text: nonEmptyStringSchema,
});

export const openAiImageContentPartSchema = z.object({
  type: z.literal("image_url"),
  image_url: openAiImageUrlSchema,
});

export const openAiMessageContentPartSchema = z.union([
  openAiTextContentPartSchema,
  openAiImageContentPartSchema,
]);

export const openAiMessageContentSchema = z.union([
  z.string(),
  z.array(openAiMessageContentPartSchema).min(1),
]);

export const openAiToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: nonEmptyStringSchema,
    description: z.string().optional(),
    parameters: jsonRecordSchema.default({}),
  }),
});

export const openAiToolCallSchema = z.object({
  id: nonEmptyStringSchema,
  type: z.literal("function"),
  function: z.object({
    name: nonEmptyStringSchema,
    arguments: z.string(),
  }),
});

export const openAiMessageSchema = z.object({
  role: openAiRoleSchema,
  content: openAiMessageContentSchema.nullable(),
  reasoning_content: z.string().nullable().optional(),
  name: nonEmptyStringSchema.optional(),
  tool_call_id: nonEmptyStringSchema.optional(),
  tool_calls: z.array(openAiToolCallSchema).optional(),
});

export const openAiUsageSchema = z.object({
  prompt_tokens: positiveIntegerSchema,
  completion_tokens: positiveIntegerSchema,
  total_tokens: positiveIntegerSchema,
});

export const chatCompletionsRequestSchema = z.object({
  model: nonEmptyStringSchema,
  messages: z.array(openAiMessageSchema).min(1),
  stream: z.boolean().default(false),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: positiveIntegerSchema.optional(),
  tools: z.array(openAiToolSchema).optional(),
  extra_body: z
    .object({
      localhub: z
        .object({
          prompt_cache_key: nonEmptyStringSchema.optional(),
          trace_label: nonEmptyStringSchema.optional(),
          ttl_override_ms: positiveIntegerSchema.optional(),
        })
        .optional(),
    })
    .optional(),
});

export const chatCompletionChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  finish_reason: z.string().nullable(),
  message: openAiMessageSchema,
});

export const chatCompletionChunkChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  finish_reason: z.string().nullable().optional(),
  delta: z.object({
    role: openAiRoleSchema.optional(),
    content: z.string().nullable().optional(),
    reasoning_content: z.string().nullable().optional(),
    tool_calls: z.array(openAiToolCallSchema).optional(),
  }),
});

export const chatCompletionsResponseSchema = z.object({
  id: nonEmptyStringSchema,
  object: z.literal("chat.completion"),
  created: z.number().int().nonnegative(),
  model: nonEmptyStringSchema,
  choices: z.array(chatCompletionChoiceSchema),
  usage: openAiUsageSchema.optional(),
});

export const chatCompletionsChunkSchema = z.object({
  id: nonEmptyStringSchema,
  object: z.literal("chat.completion.chunk"),
  created: z.number().int().nonnegative(),
  model: nonEmptyStringSchema,
  choices: z.array(chatCompletionChunkChoiceSchema),
  usage: openAiUsageSchema.optional(),
});

export const embeddingsRequestSchema = z.object({
  model: nonEmptyStringSchema,
  input: z.union([z.string(), z.array(z.string()).min(1)]),
  user: nonEmptyStringSchema.optional(),
});

export const embeddingsResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(
    z.object({
      object: z.literal("embedding"),
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number()),
    }),
  ),
  model: nonEmptyStringSchema,
  usage: openAiUsageSchema.optional(),
});

export const openAiModelCardSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema.optional(),
  model_id: nonEmptyStringSchema.optional(),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: nonEmptyStringSchema,
});

export const openAiModelListSchema = z.object({
  object: z.literal("list"),
  data: z.array(openAiModelCardSchema),
});

export const openAiErrorResponseSchema = z.object({
  error: z.object({
    message: nonEmptyStringSchema,
    type: nonEmptyStringSchema.optional(),
    param: nonEmptyStringSchema.nullable().optional(),
    code: z.union([nonEmptyStringSchema, z.number().int()]).nullable().optional(),
  }),
});

export type ChatCompletionsRequest = z.infer<typeof chatCompletionsRequestSchema>;
export type ChatCompletionsResponse = z.infer<typeof chatCompletionsResponseSchema>;
export type ChatCompletionsChunk = z.infer<typeof chatCompletionsChunkSchema>;
export type EmbeddingsRequest = z.infer<typeof embeddingsRequestSchema>;
export type EmbeddingsResponse = z.infer<typeof embeddingsResponseSchema>;
export type OpenAiModelCard = z.infer<typeof openAiModelCardSchema>;
export type OpenAiModelList = z.infer<typeof openAiModelListSchema>;
export type OpenAiErrorResponse = z.infer<typeof openAiErrorResponseSchema>;
export type OpenAiToolCall = z.infer<typeof openAiToolCallSchema>;
export type OpenAiMessageContent = z.infer<typeof openAiMessageContentSchema>;
export type OpenAiMessageContentPart = z.infer<typeof openAiMessageContentPartSchema>;
