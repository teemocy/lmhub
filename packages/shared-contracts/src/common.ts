import { z } from "zod";

export const CONTRACT_SCHEMA_VERSION = 1;

export const schemaVersionSchema = z.number().int().positive();
export const isoDatetimeSchema = z.string().datetime({ offset: true });
export const nonEmptyStringSchema = z.string().trim().min(1);
export const fileSystemPathSchema = nonEmptyStringSchema;
export const traceIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export const runtimeEnvironmentSchema = z.enum(["development", "packaged", "test"]);
export const positiveIntegerSchema = z.number().int().nonnegative();
export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);
export const jsonRecordSchema = z.record(jsonValueSchema);

export type LogLevel = z.infer<typeof logLevelSchema>;
export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;
