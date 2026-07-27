/**
 * Live Bedrock on-demand token pricing via the AWS Price List API.
 *
 * Purpose: Resolve USD-per-1M input/output rates for known Bedrock model IDs
 * so Super Admin AI Engine can show estimated run cost from AWS list prices
 * instead of only hardcoded fallbacks.
 *
 * Inputs: Bedrock region (AWS_REGION) + model catalog entries with id/label/
 *   fallback inputPer1M/outputPer1M.
 * Outputs: Per-model rates with source "aws" | "fallback", plus fetch metadata.
 *
 * Notes:
 * - Pricing API endpoint is always us-east-1 (or ap-south-1).
 * - Amazon Nova rates come from service code AmazonBedrock.
 * - Newer Claude rates come from AmazonBedrockFoundationModels (Marketplace).
 * - Results are cached in-process for CACHE_TTL_MS to avoid slow page loads.
 *
 * Changelog:
 * - 2026-07-27: Added live Price List lookup for Super Admin AI Engine estimates.
 */
import {
  GetProductsCommand,
  PricingClient,
} from "@aws-sdk/client-pricing";

const PRICING_API_REGION = "us-east-1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SERVICE_CODES = [
  "AmazonBedrock",
  "AmazonBedrockService",
  "AmazonBedrockFoundationModels",
] as const;

export type BedrockModelPricingInput = {
  id: string;
  label: string;
  inputPer1M: number;
  outputPer1M: number;
};

export type BedrockModelLiveRate = {
  modelId: string;
  inputPer1M: number;
  outputPer1M: number;
  source: "aws" | "fallback";
};

export type BedrockPricingSnapshot = {
  rates: BedrockModelLiveRate[];
  pricingSource: "aws" | "fallback" | "mixed";
  pricingFetchedAt: string;
  awsModelCount: number;
};

type CachedSnapshot = {
  expiresAt: number;
  snapshot: BedrockPricingSnapshot;
};

type ParsedPriceRow = {
  serviceCode: string;
  model: string;
  serviceName: string;
  usageType: string;
  inferenceType: string;
  feature: string;
  pricePer1M: number | null;
};

let cache: CachedSnapshot | null = null;

/**
 * Convert an OnDemand price dimension unit into USD per 1M tokens.
 * Returns null when the unit is not token-based.
 */
function toPer1M(usd: number, unit: string): number | null {
  if (!Number.isFinite(usd)) return null;
  if (/1\s*M/i.test(unit)) return usd;
  if (/1\s*K/i.test(unit)) return usd * 1000;
  return null;
}

/**
 * Extract the first OnDemand USD price from a Price List product JSON object.
 */
function extractOnDemandPer1M(product: Record<string, unknown>): number | null {
  const terms = (product.terms as { OnDemand?: Record<string, unknown> } | undefined)
    ?.OnDemand;
  if (!terms) return null;
  for (const term of Object.values(terms)) {
    const dims = (term as { priceDimensions?: Record<string, unknown> })
      .priceDimensions;
    if (!dims) continue;
    for (const dim of Object.values(dims)) {
      const d = dim as {
        pricePerUnit?: { USD?: string };
        unit?: string;
      };
      const usd = Number(d.pricePerUnit?.USD);
      const per1M = toPer1M(usd, String(d.unit || ""));
      if (per1M != null) return per1M;
    }
  }
  return null;
}

/**
 * Create a Pricing client using the same env credentials as Bedrock/S3/SES.
 * Pricing API requires us-east-1 regardless of Bedrock region.
 */
function createPricingClient(): PricingClient | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) return null;
  return new PricingClient({
    region: PRICING_API_REGION,
    credentials: { accessKeyId, secretAccessKey },
  });
}

/**
 * Page through GetProducts for one service code in the Bedrock region.
 */
async function fetchServiceProducts(
  client: PricingClient,
  serviceCode: string,
  regionCode: string,
): Promise<ParsedPriceRow[]> {
  const rows: ParsedPriceRow[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new GetProductsCommand({
        ServiceCode: serviceCode,
        Filters: [
          { Type: "TERM_MATCH", Field: "regionCode", Value: regionCode },
        ],
        MaxResults: 100,
        NextToken: nextToken,
      }),
    );
    for (const raw of res.PriceList ?? []) {
      try {
        const product = JSON.parse(raw) as Record<string, unknown>;
        const attrs =
          (product.product as { attributes?: Record<string, string> } | undefined)
            ?.attributes ?? {};
        rows.push({
          serviceCode,
          model: attrs.model || attrs.titanModel || "",
          serviceName: attrs.servicename || "",
          usageType: attrs.usagetype || "",
          inferenceType: attrs.inferenceType || "",
          feature: attrs.feature || "",
          pricePer1M: extractOnDemandPer1M(product),
        });
      } catch {
        /* skip malformed price list rows */
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return rows;
}

/**
 * True when a usage/feature string looks like standard on-demand text tokens
 * (excludes cache, batch, reserved, provisioned, media, flex, priority).
 */
function isStandardTokenUsage(row: ParsedPriceRow): boolean {
  const blob = `${row.usageType} ${row.inferenceType} ${row.feature}`.toLowerCase();
  if (
    /cache|batch|reserved|provisioned|custom|flex|priority|latency|long-context|image|video|audio|tpm/.test(
      blob,
    )
  ) {
    return false;
  }
  return /token/.test(blob);
}

function isInputRow(row: ParsedPriceRow): boolean {
  const blob = `${row.usageType} ${row.inferenceType}`.toLowerCase();
  return /input/.test(blob) && !/output/.test(blob);
}

function isOutputRow(row: ParsedPriceRow): boolean {
  const blob = `${row.usageType} ${row.inferenceType}`.toLowerCase();
  return /output|response/.test(blob);
}

/**
 * Prefer exact regional on-demand SKUs over Global / cross-region variants.
 * Lower score = better match.
 */
function rankRow(row: ParsedPriceRow): number {
  let score = 0;
  const usage = row.usageType.toLowerCase();
  if (/global|cross-region/.test(usage)) score += 10;
  if (row.serviceCode === "AmazonBedrockFoundationModels") {
    // Prefer plain InputTokenCount-Units / OutputTokenCount-Units
    if (/inputtokencount-units$/i.test(usage) || /outputtokencount-units$/i.test(usage)) {
      score -= 5;
    }
  }
  if (row.serviceCode === "AmazonBedrock") {
    if (/-(input|output)-tokens$/i.test(row.usageType)) score -= 5;
    if (/on-demand inference/i.test(row.feature)) score -= 2;
  }
  return score;
}

/**
 * Match catalog model to a live price row using display label / marketplace name.
 */
function rowMatchesModel(row: ParsedPriceRow, model: BedrockModelPricingInput): boolean {
  const label = model.label.toLowerCase();
  if (row.model.toLowerCase() === label) return true;
  const service = row.serviceName.toLowerCase();
  if (service.startsWith(`${label} (`)) return true;
  if (service.includes(`${label} (amazon bedrock edition)`)) return true;
  return false;
}

/**
 * Pick best input and output USD/1M rates for one model from parsed rows.
 */
function resolveModelRates(
  model: BedrockModelPricingInput,
  rows: ParsedPriceRow[],
): { inputPer1M: number; outputPer1M: number; source: "aws" | "fallback" } {
  const candidates = rows.filter(
    (r) =>
      r.pricePer1M != null &&
      rowMatchesModel(r, model) &&
      isStandardTokenUsage(r),
  );

  const pick = (predicate: (r: ParsedPriceRow) => boolean): number | null => {
    const matched = candidates.filter(predicate).sort((a, b) => rankRow(a) - rankRow(b));
    return matched[0]?.pricePer1M ?? null;
  };

  const input = pick(isInputRow);
  const output = pick(isOutputRow);

  if (input != null && output != null) {
    return { inputPer1M: input, outputPer1M: output, source: "aws" };
  }
  return {
    inputPer1M: model.inputPer1M,
    outputPer1M: model.outputPer1M,
    source: "fallback",
  };
}

/**
 * Fetch live Bedrock list prices for the given model catalog.
 * Falls back to each model's hardcoded inputPer1M/outputPer1M when AWS is
 * unavailable or a model SKU is missing. Uses a 24h in-memory cache.
 *
 * @param models Catalog entries (id, label, fallback rates)
 * @returns Snapshot with per-model rates and overall pricingSource
 */
export async function getBedrockLivePricing(
  models: readonly BedrockModelPricingInput[],
): Promise<BedrockPricingSnapshot> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.snapshot;
  }

  const fetchedAt = new Date().toISOString();
  const fallbackRates: BedrockModelLiveRate[] = models.map((m) => ({
    modelId: m.id,
    inputPer1M: m.inputPer1M,
    outputPer1M: m.outputPer1M,
    source: "fallback" as const,
  }));

  const client = createPricingClient();
  if (!client) {
    const snapshot: BedrockPricingSnapshot = {
      rates: fallbackRates,
      pricingSource: "fallback",
      pricingFetchedAt: fetchedAt,
      awsModelCount: 0,
    };
    cache = { expiresAt: now + CACHE_TTL_MS, snapshot };
    return snapshot;
  }

  const regionCode = process.env.AWS_REGION?.trim() || "us-east-1";
  try {
    const rowSets = await Promise.all(
      SERVICE_CODES.map((sc) => fetchServiceProducts(client, sc, regionCode)),
    );
    const rows = rowSets.flat();
    const rates = models.map((m) => {
      const resolved = resolveModelRates(m, rows);
      return {
        modelId: m.id,
        inputPer1M: resolved.inputPer1M,
        outputPer1M: resolved.outputPer1M,
        source: resolved.source,
      };
    });
    const awsModelCount = rates.filter((r) => r.source === "aws").length;
    const pricingSource: BedrockPricingSnapshot["pricingSource"] =
      awsModelCount === 0
        ? "fallback"
        : awsModelCount === rates.length
          ? "aws"
          : "mixed";
    const snapshot: BedrockPricingSnapshot = {
      rates,
      pricingSource,
      pricingFetchedAt: fetchedAt,
      awsModelCount,
    };
    cache = { expiresAt: now + CACHE_TTL_MS, snapshot };
    return snapshot;
  } catch (err) {
    console.error("[bedrock-pricing] Price List fetch failed; using fallbacks", err);
    const snapshot: BedrockPricingSnapshot = {
      rates: fallbackRates,
      pricingSource: "fallback",
      pricingFetchedAt: fetchedAt,
      awsModelCount: 0,
    };
    // Shorter cache on failure so the next request can retry sooner
    cache = { expiresAt: now + 5 * 60 * 1000, snapshot };
    return snapshot;
  }
}
