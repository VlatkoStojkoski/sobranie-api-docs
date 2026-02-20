import { createEnv } from '@t3-oss/env-core';
import { config as loadDotEnv } from 'dotenv';
import { z } from 'zod';

loadDotEnv();

const envSchema = createEnv({
  server: {
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().trim().min(1).optional(),
    SUGGESTIONS_PROMPT_BACKEND: z
      .enum(['google_genai', 'google-genai', 'vercel'])
      .optional(),
    SOBRANIE_SESSIONS_DIR: z.string().trim().min(1).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export const env = envSchema;
