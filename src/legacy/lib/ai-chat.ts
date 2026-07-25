import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { getPlatformSetting } from "./platform-settings";

/**
 * Shared AI chat helper for ForkUp Server.
 *
 * Prefers AWS Bedrock (Converse API) when AWS credentials are configured.
 * Falls back to the Lovable AI gateway only when Bedrock is not configured
 * and LOVABLE_API_KEY is present.
 *
 * Inputs: system prompt + user prompt (+ optional JSON mode hint).
 * Output: plain assistant text string.
 */

export type AiChatOptions = {
  system: string;
  user: string;
  /** Hint the model to return JSON only (appended to system when true). */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
};

function bedrockConfigured(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID?.trim() &&
      process.env.AWS_SECRET_ACCESS_KEY?.trim() &&
      (process.env.AWS_REGION?.trim() || "us-east-1"),
  );
}

function lovableConfigured(): boolean {
  return Boolean(process.env.LOVABLE_API_KEY?.trim());
}

/** Active provider for health/debug (never logs secrets). */
export function aiProviderName(): "bedrock" | "lovable" | "none" {
  if (bedrockConfigured()) return "bedrock";
  if (lovableConfigured()) return "lovable";
  return "none";
}

function bedrockModelId(): string {
  return (
    process.env.BEDROCK_MODEL_ID?.trim() ||
    // Amazon Nova Lite — fast/cheap default for drafts (Nick V2 direction).
    "amazon.nova-lite-v1:0"
  );
}

/** Prefer Super Admin–selected model from platform_settings when available. */
async function resolveBedrockModelId(): Promise<string> {
  try {
    const fromDb = await getPlatformSetting("ai_model_id");
    if (fromDb?.trim()) return fromDb.trim();
  } catch {
    /* fall through to env default */
  }
  return bedrockModelId();
}

async function chatViaBedrock(options: AiChatOptions): Promise<string> {
  const region = process.env.AWS_REGION?.trim() || "us-east-1";
  const client = new BedrockRuntimeClient({
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!.trim(),
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!.trim(),
    },
  });

  const systemText = options.json
    ? `${options.system}\nReturn ONLY valid JSON. No markdown fences or commentary.`
    : options.system;

  const command = new ConverseCommand({
    modelId: await resolveBedrockModelId(),
    system: [{ text: systemText }],
    messages: [
      {
        role: "user",
        content: [{ text: options.user }],
      },
    ],
    inferenceConfig: {
      maxTokens: options.maxTokens ?? 2048,
      temperature: options.temperature ?? 0.4,
    },
  });

  const response = await client.send(command);
  const parts = response.output?.message?.content ?? [];
  const text = parts
    .map((p) => ("text" in p && typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();

  if (!text) {
    throw new Error("Bedrock returned an empty response.");
  }
  return text;
}

async function chatViaLovable(options: AiChatOptions): Promise<string> {
  const apiKey = process.env.LOVABLE_API_KEY!.trim();
  const system = options.json
    ? `${options.system}\nReturn ONLY valid JSON. No markdown fences or commentary.`
    : options.system;

  const upstream = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": apiKey,
    },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      ...(options.json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: options.user },
      ],
    }),
  });

  if (upstream.status === 429) throw new Error("Rate limited. Please try again in a moment.");
  if (upstream.status === 402) throw new Error("AI credits exhausted. Please add credits to continue.");
  if (!upstream.ok) throw new Error("AI request failed. Please try again.");

  const json = (await upstream.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = json.choices?.[0]?.message?.content?.trim() ?? "";
  if (!content) throw new Error("AI returned an empty response.");
  return content;
}

/**
 * Run a chat completion via Bedrock (preferred) or Lovable (fallback).
 */
export async function aiChat(options: AiChatOptions): Promise<string> {
  if (bedrockConfigured()) {
    return chatViaBedrock(options);
  }
  if (lovableConfigured()) {
    return chatViaLovable(options);
  }
  throw new Error(
    "No AI provider configured. Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION (Bedrock) or LOVABLE_API_KEY.",
  );
}

/** Strip optional markdown fences then parse JSON. */
export function parseAiJson<T extends Record<string, unknown>>(raw: string): T {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned) as T;
}
