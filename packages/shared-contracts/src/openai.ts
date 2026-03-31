import { z } from "zod";

import { jsonRecordSchema, nonEmptyStringSchema, positiveIntegerSchema } from "./common.js";

export const openAiRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

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
  content: z.union([z.string(), z.array(jsonRecordSchema)]).nullable(),
  name: nonEmptyStringSchema.optional(),
  tool_call_id: nonEmptyStringSchema.optional(),
  tool_calls: z.array(openAiToolCallSchema).optional(),
});

export const chatCompletionsRequestSchema = z.object({
  model: nonEmptyStringSchema,
  messages: z.array(openAiMessageSchema).min(1),
  stream: z.boolean().default(false),
  temperature: z.number().min(0).max(2).optional(),
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

export const chatCompletionsResponseSchema = z.object({
  id: nonEmptyStringSchema,
  object: z.literal("chat.completion"),
  created: z.number().int().nonnegative(),
  model: nonEmptyStringSchema,
  choices: z.array(chatCompletionChoiceSchema),
  usage: z
    .object({
      prompt_tokens: positiveIntegerSchema,
      completion_tokens: positiveIntegerSchema,
      total_tokens: positiveIntegerSchema,
    })
    .optional(),
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
});

export type ChatCompletionsRequest = z.infer<typeof chatCompletionsRequestSchema>;
export type ChatCompletionsResponse = z.infer<typeof chatCompletionsResponseSchema>;
export type EmbeddingsRequest = z.infer<typeof embeddingsRequestSchema>;
export type EmbeddingsResponse = z.infer<typeof embeddingsResponseSchema>;
