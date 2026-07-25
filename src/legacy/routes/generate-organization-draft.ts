import { Router } from "express";
import { aiChat, aiProviderName, parseAiJson } from "../lib/ai-chat";
import { findKnownOrganizationProfile, findKnownOrganizationByName } from "../lib/known-organization-profiles";

export const generateOrganizationDraftRouter = Router();

/**
 * Build-from-website organization draft.
 *
 * method: POST /api/generate-organization-draft
 * request: { website: string, kind?: "nonprofit" | "business", extraContext?: string }
 * response: { website, kind, generatedFields, confirmationStatus, provider, orgType?, social?, missingFields? }
 *
 * Order (Lovable parity):
 * 1) Curated known-domain registry (correct Headstrong / YMCA / etc.)
 * 2) AWS Bedrock / Lovable AI only when the domain is unknown
 */
generateOrganizationDraftRouter.post("/generate-organization-draft", async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      website?: string;
      name?: string;
      kind?: string;
      extraContext?: string;
    };

    const website = typeof body.website === "string" ? body.website.trim() : "";
    const nameQuery = typeof body.name === "string" ? body.name.trim() : "";
    if ((!website || website.length > 2048) && !nameQuery) {
      res.status(400).json({ error: "A website URL or organization name is required." });
      return;
    }

    const kind = body.kind === "business" ? "business" : "nonprofit";

    // ── 1) Known profile registry (website first, then name — Lovable parity) ──
    const known =
      (website ? findKnownOrganizationProfile(website) : null) ||
      (nameQuery || website ? findKnownOrganizationByName(nameQuery || website) : null);
    if (known) {
      const missingFields: string[] = [];
      if (!known.contactEmail?.trim()) missingFields.push("Primary contact email");
      // Contact name is never in the registry — always still needed (Lovable UI).
      missingFields.unshift("Primary contact name");

      res.json({
        website: known.website,
        kind,
        generatedFields: {
          organizationName: known.organizationName,
          missionStatement: known.missionStatement,
          about: known.about,
          website: known.website,
          contactEmail: known.contactEmail,
          phone: known.phone,
          location: known.location,
          causeCategory: known.causeCategory,
          city: known.city,
          state: known.state,
          ein: known.ein,
        },
        orgType: known.orgType,
        social: known.social,
        missingFields,
        lastAiGeneratedAt: new Date().toISOString(),
        confirmationStatus: "Found Profile",
        provider: "known_profile",
      });
      return;
    }

    // ── 2) Name-only (no website): known profile already checked; AI draft from name ──
    // Never return an empty name_seed stub — that caused blank "AI Draft" reviews.
    if (!website && nameQuery) {
      if (aiProviderName() === "none") {
        res.status(503).json({
          error:
            "No AI provider configured. Set AWS Bedrock credentials or LOVABLE_API_KEY, or enter the official website URL.",
        });
        return;
      }

      try {
        const fields = [
          "organizationName",
          "missionStatement",
          "about",
          "website",
          "contactEmail",
          "phone",
          "location",
          "causeCategory",
          "city",
          "state",
          "ein",
        ];
        const system = [
          "You are an assistant that drafts ForkUp nonprofit organization profiles from an organization name.",
          "Return a DRAFT for human review. Prefer well-known public facts for major US nonprofits (e.g. Feeding America is a national hunger-relief network).",
          "Never invent exact EINs or private phone numbers — leave those empty if unsure.",
          `Return ONLY a JSON object with exactly these keys: ${fields.join(", ")}.`,
          "Each value must be a plain string. Put the best official website in website when known.",
        ].join("\n");

        const content = await aiChat({
          system,
          user: `Organization name: ${nameQuery}`,
          json: true,
          maxTokens: 2048,
          temperature: 0.2,
        });

        let parsed: Record<string, unknown> = {};
        try {
          parsed = parseAiJson(content);
        } catch {
          parsed = {};
        }

        const generatedFields: Record<string, string> = {};
        for (const key of fields) {
          const value = parsed[key];
          generatedFields[key] =
            typeof value === "string" ? value : value == null ? "" : String(value);
        }
        if (!generatedFields.organizationName?.trim()) {
          generatedFields.organizationName = nameQuery;
        }

        const missingFields: string[] = ["Primary contact name"];
        if (!generatedFields.contactEmail?.trim()) missingFields.push("Primary contact email");
        if (!generatedFields.website?.trim()) missingFields.push("Website");
        if (!generatedFields.missionStatement?.trim() && !generatedFields.about?.trim()) {
          missingFields.push("Mission or short description");
        }
        if (!generatedFields.city?.trim() && !generatedFields.location?.trim()) {
          missingFields.push("City / state");
        }

        res.json({
          website: generatedFields.website || "",
          kind,
          generatedFields,
          orgType: "Nonprofit",
          social: [] as string[],
          missingFields,
          lastAiGeneratedAt: new Date().toISOString(),
          confirmationStatus: "AI Draft",
          provider: aiProviderName(),
        });
        return;
      } catch (err) {
        console.error("Name-only AI draft failed:", err);
        res.status(502).json({
          error:
            err instanceof Error
              ? err.message
              : "Could not draft a profile from that name. Try the official website URL.",
        });
        return;
      }
    }

    // Unknown domain — AI when we have a website URL
    if (!website) {
      res.status(400).json({
        error: "Enter a website URL or an organization name to continue.",
      });
      return;
    }

    if (aiProviderName() === "none") {
      res.status(503).json({
        error:
          "No AI provider configured. Set AWS Bedrock credentials or LOVABLE_API_KEY.",
      });
      return;
    }

    const extraContext =
      typeof body.extraContext === "string" ? body.extraContext.trim().slice(0, 1000) : "";

    const fields = [
      "organizationName",
      "missionStatement",
      "about",
      "website",
      "contactEmail",
      "phone",
      "location",
      "causeCategory",
      "city",
      "state",
      "ein",
    ];

    const system = [
      "You are an assistant that drafts ForkUp nonprofit organization profiles from a website URL.",
      "ForkUp is a fundraising platform connecting nonprofits with local businesses.",
      "CRITICAL: Do not confuse similarly named organizations. Use the exact domain.",
      "Examples of distinct orgs: headstrong.org = Headstrong Foundation (cancer/lacrosse families, Bryn Mawr PA) — NOT the veterans mental-health HEADstrong Project.",
      "You create a DRAFT for a human to review. Never invent verified facts such as exact EINs, exact phone numbers, or exact street addresses — if unsure, leave empty string.",
      "Infer only public-facing copy you are confident about from the URL hostname and context.",
      `Return ONLY a JSON object with exactly these keys: ${fields.join(", ")}.`,
      "Each value must be a plain string.",
    ].join("\n");

    const userParts = [`Primary website URL: ${website}`];
    if (extraContext) userParts.push(`Additional context: ${extraContext}`);

    const content = await aiChat({
      system,
      user: userParts.join("\n"),
      json: true,
      maxTokens: 2048,
      temperature: 0.2,
    });

    let parsed: Record<string, unknown>;
    try {
      parsed = parseAiJson(content);
    } catch {
      res.status(502).json({ error: "Could not read the generated draft." });
      return;
    }

    const generatedFields: Record<string, string> = {};
    for (const key of fields) {
      const value = parsed[key];
      generatedFields[key] = typeof value === "string" ? value : value == null ? "" : String(value);
    }

    if (!generatedFields.website?.trim()) {
      generatedFields.website = website;
    }

    const missingFields: string[] = ["Primary contact name"];
    if (!generatedFields.contactEmail?.trim()) missingFields.push("Primary contact email");
    if (!generatedFields.city?.trim() && !generatedFields.location?.trim()) {
      missingFields.push("City / state");
    }

    res.json({
      website,
      kind,
      generatedFields,
      orgType: "Nonprofit",
      social: [] as string[],
      missingFields,
      lastAiGeneratedAt: new Date().toISOString(),
      confirmationStatus: "AI Draft",
      provider: aiProviderName(),
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Failed to generate organization draft";
    const status =
      message.toLowerCase().includes("rate") ? 429 :
      message.toLowerCase().includes("credit") ? 402 :
      message.toLowerCase().includes("no ai provider") ? 503 :
      500;
    res.status(status).json({ error: message });
  }
});
