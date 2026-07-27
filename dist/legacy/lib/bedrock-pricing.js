"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBedrockLivePricing = getBedrockLivePricing;
const client_pricing_1 = require("@aws-sdk/client-pricing");
const PRICING_API_REGION = "us-east-1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SERVICE_CODES = [
    "AmazonBedrock",
    "AmazonBedrockService",
    "AmazonBedrockFoundationModels",
];
let cache = null;
function toPer1M(usd, unit) {
    if (!Number.isFinite(usd))
        return null;
    if (/1\s*M/i.test(unit))
        return usd;
    if (/1\s*K/i.test(unit))
        return usd * 1000;
    return null;
}
function extractOnDemandPer1M(product) {
    const terms = product.terms
        ?.OnDemand;
    if (!terms)
        return null;
    for (const term of Object.values(terms)) {
        const dims = term
            .priceDimensions;
        if (!dims)
            continue;
        for (const dim of Object.values(dims)) {
            const d = dim;
            const usd = Number(d.pricePerUnit?.USD);
            const per1M = toPer1M(usd, String(d.unit || ""));
            if (per1M != null)
                return per1M;
        }
    }
    return null;
}
function createPricingClient() {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
    if (!accessKeyId || !secretAccessKey)
        return null;
    return new client_pricing_1.PricingClient({
        region: PRICING_API_REGION,
        credentials: { accessKeyId, secretAccessKey },
    });
}
async function fetchServiceProducts(client, serviceCode, regionCode) {
    const rows = [];
    let nextToken;
    do {
        const res = await client.send(new client_pricing_1.GetProductsCommand({
            ServiceCode: serviceCode,
            Filters: [
                { Type: "TERM_MATCH", Field: "regionCode", Value: regionCode },
            ],
            MaxResults: 100,
            NextToken: nextToken,
        }));
        for (const raw of res.PriceList ?? []) {
            try {
                const product = JSON.parse(raw);
                const attrs = product.product
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
            }
            catch {
            }
        }
        nextToken = res.NextToken;
    } while (nextToken);
    return rows;
}
function isStandardTokenUsage(row) {
    const blob = `${row.usageType} ${row.inferenceType} ${row.feature}`.toLowerCase();
    if (/cache|batch|reserved|provisioned|custom|flex|priority|latency|long-context|image|video|audio|tpm/.test(blob)) {
        return false;
    }
    return /token/.test(blob);
}
function isInputRow(row) {
    const blob = `${row.usageType} ${row.inferenceType}`.toLowerCase();
    return /input/.test(blob) && !/output/.test(blob);
}
function isOutputRow(row) {
    const blob = `${row.usageType} ${row.inferenceType}`.toLowerCase();
    return /output|response/.test(blob);
}
function rankRow(row) {
    let score = 0;
    const usage = row.usageType.toLowerCase();
    if (/global|cross-region/.test(usage))
        score += 10;
    if (row.serviceCode === "AmazonBedrockFoundationModels") {
        if (/inputtokencount-units$/i.test(usage) || /outputtokencount-units$/i.test(usage)) {
            score -= 5;
        }
    }
    if (row.serviceCode === "AmazonBedrock") {
        if (/-(input|output)-tokens$/i.test(row.usageType))
            score -= 5;
        if (/on-demand inference/i.test(row.feature))
            score -= 2;
    }
    return score;
}
function rowMatchesModel(row, model) {
    const label = model.label.toLowerCase();
    if (row.model.toLowerCase() === label)
        return true;
    const service = row.serviceName.toLowerCase();
    if (service.startsWith(`${label} (`))
        return true;
    if (service.includes(`${label} (amazon bedrock edition)`))
        return true;
    return false;
}
function resolveModelRates(model, rows) {
    const candidates = rows.filter((r) => r.pricePer1M != null &&
        rowMatchesModel(r, model) &&
        isStandardTokenUsage(r));
    const pick = (predicate) => {
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
async function getBedrockLivePricing(models) {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
        return cache.snapshot;
    }
    const fetchedAt = new Date().toISOString();
    const fallbackRates = models.map((m) => ({
        modelId: m.id,
        inputPer1M: m.inputPer1M,
        outputPer1M: m.outputPer1M,
        source: "fallback",
    }));
    const client = createPricingClient();
    if (!client) {
        const snapshot = {
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
        const rowSets = await Promise.all(SERVICE_CODES.map((sc) => fetchServiceProducts(client, sc, regionCode)));
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
        const pricingSource = awsModelCount === 0
            ? "fallback"
            : awsModelCount === rates.length
                ? "aws"
                : "mixed";
        const snapshot = {
            rates,
            pricingSource,
            pricingFetchedAt: fetchedAt,
            awsModelCount,
        };
        cache = { expiresAt: now + CACHE_TTL_MS, snapshot };
        return snapshot;
    }
    catch (err) {
        console.error("[bedrock-pricing] Price List fetch failed; using fallbacks", err);
        const snapshot = {
            rates: fallbackRates,
            pricingSource: "fallback",
            pricingFetchedAt: fetchedAt,
            awsModelCount: 0,
        };
        cache = { expiresAt: now + 5 * 60 * 1000, snapshot };
        return snapshot;
    }
}
//# sourceMappingURL=bedrock-pricing.js.map