/**
 * Purpose: Per-user Bedrock model preference (Dermwrite-style user AI engine).
 * Inputs: user id, optional model id. Outputs: resolved model id string.
 */
import { pool } from "../db/pool";
import { getPlatformSetting } from "./platform-settings";
import {
  DEFAULT_BEDROCK_MODEL_ID,
  isAllowedBedrockModel,
  migrateBedrockModelId,
} from "./bedrock-model-catalog";

export async function getUserAiBedrockModel(userId: number): Promise<string | null> {
  const { rows } = await pool.query<{ ai_bedrock_model: string | null }>(
    `SELECT ai_bedrock_model FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const raw = rows[0]?.ai_bedrock_model;
  if (!raw?.trim()) return null;
  return migrateBedrockModelId(raw);
}

export async function setUserAiBedrockModel(userId: number, modelId: string): Promise<string> {
  const next = migrateBedrockModelId(modelId);
  if (!isAllowedBedrockModel(next)) {
    throw new Error(`Unsupported Bedrock model: ${modelId}`);
  }
  await pool.query(
    `UPDATE users SET ai_bedrock_model = $1, updated_at = NOW() WHERE id = $2`,
    [next, userId],
  );
  return next;
}

/**
 * Purpose: Resolve Bedrock model for text/vision AI for a request.
 * Priority: request body > user preference > platform default > env default.
 */
export async function resolveUserBedrockModelId(input: {
  requestModelId?: string | null;
  userId?: number | null;
  platformSettingKey?: "ai_model_id" | "receipt_ai_model_id";
  envDefault?: string;
}): Promise<string> {
  const requested = String(input.requestModelId ?? "").trim();
  if (requested && isAllowedBedrockModel(requested)) {
    return migrateBedrockModelId(requested);
  }

  const userId = Number(input.userId);
  if (userId > 0) {
    const userModel = await getUserAiBedrockModel(userId);
    if (userModel) return userModel;
  }

  const platformKey = input.platformSettingKey ?? "ai_model_id";
  try {
    const fromPlatform = await getPlatformSetting(platformKey);
    if (fromPlatform?.trim() && isAllowedBedrockModel(fromPlatform.trim())) {
      return migrateBedrockModelId(fromPlatform.trim());
    }
  } catch {
    /* fall through */
  }

  const envDefault =
    input.envDefault?.trim() ||
    process.env.BEDROCK_MODEL_ID?.trim() ||
    process.env.BEDROCK_RECEIPT_MODEL_ID?.trim() ||
    DEFAULT_BEDROCK_MODEL_ID;
  return migrateBedrockModelId(envDefault);
}
