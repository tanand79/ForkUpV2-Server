import { Router } from "express";
import type { QueryResultRow } from "pg";
import { bearerToken, resolveAuthUser } from "../lib/auth";
import { pool } from "../db/pool";

export const libraryRouter = Router();

const ORG_TYPES = ["nonprofit", "business"] as const;
type OrgType = (typeof ORG_TYPES)[number];

const LIBRARY_CATEGORIES = [
  "logos_brand",
  "photos_images",
  "flyers_documents",
  "stories_testimonials",
  "past_events",
  "results_impact",
  "reusable_content",
  "website_scan",
  "social_links",
  "contact_info",
  "brand_assets",
] as const;

const REVIEW_STATUSES = ["pending", "approved", "rejected", "ignored"] as const;
const SOURCES = ["manual", "website_scan", "social_scan", "import"] as const;

function isOrgType(value: string): value is OrgType {
  return (ORG_TYPES as readonly string[]).includes(value);
}

type LibraryRow = QueryResultRow & {
  id: number;
  organization_type: string;
  organization_id: number;
  category: string;
  title: string | null;
  description: string | null;
  content: string | null;
  asset_url: string | null;
  source: string;
  source_url: string | null;
  review_status: string;
  metadata_json: unknown;
  created_by_user_id: number | null;
  created_at: Date;
  updated_at: Date;
};

function mapItem(row: LibraryRow) {
  return {
    id: row.id,
    organizationType: row.organization_type,
    organizationId: row.organization_id,
    category: row.category,
    title: row.title,
    description: row.description,
    content: row.content,
    assetUrl: row.asset_url,
    source: row.source,
    sourceUrl: row.source_url,
    reviewStatus: row.review_status,
    metadata: row.metadata_json,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

libraryRouter.get("/:orgType/:orgId", async (req, res) => {
  try {
    const orgType = req.params.orgType;
    const orgId = Number(req.params.orgId);
    if (!isOrgType(orgType) || !orgId) {
      res.status(400).json({ error: "Valid organization type and id are required" });
      return;
    }

    const conditions = ["organization_type = $1", "organization_id = $2"];
    const params: unknown[] = [orgType, orgId];

    const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
    if (category) {
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }

    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    if (status) {
      params.push(status);
      conditions.push(`review_status = $${params.length}`);
    }

    const source = typeof req.query.source === "string" ? req.query.source.trim() : "";
    if (source) {
      params.push(source);
      conditions.push(`source = $${params.length}`);
    }

    const { rows } = await pool.query<LibraryRow>(
      `SELECT * FROM organization_library_items
       WHERE ${conditions.join(" AND ")}
       ORDER BY category ASC, id DESC`,
      params,
    );

    res.json(rows.map(mapItem));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch library items" });
  }
});

libraryRouter.post("/:orgType/:orgId", async (req, res) => {
  try {
    const orgType = req.params.orgType;
    const orgId = Number(req.params.orgId);
    if (!isOrgType(orgType) || !orgId) {
      res.status(400).json({ error: "Valid organization type and id are required" });
      return;
    }

    const body = req.body as {
      category?: string;
      title?: string;
      description?: string;
      content?: string;
      assetUrl?: string;
      source?: string;
      sourceUrl?: string;
      reviewStatus?: string;
      metadata?: unknown;
    };

    const category = typeof body.category === "string" ? body.category.trim() : "";
    if (!(LIBRARY_CATEGORIES as readonly string[]).includes(category)) {
      res.status(400).json({
        error: `category must be one of: ${LIBRARY_CATEGORIES.join(", ")}`,
      });
      return;
    }

    const source =
      typeof body.source === "string" && (SOURCES as readonly string[]).includes(body.source)
        ? body.source
        : "manual";
    const reviewStatus =
      typeof body.reviewStatus === "string" &&
      (REVIEW_STATUSES as readonly string[]).includes(body.reviewStatus)
        ? body.reviewStatus
        : "pending";

    const user = await resolveAuthUser(bearerToken(req));

    const { rows } = await pool.query<LibraryRow>(
      `INSERT INTO organization_library_items (
        organization_type, organization_id, category, title, description,
        content, asset_url, source, source_url, review_status, metadata_json,
        created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        orgType,
        orgId,
        category,
        typeof body.title === "string" ? body.title : null,
        typeof body.description === "string" ? body.description : null,
        typeof body.content === "string" ? body.content : null,
        typeof body.assetUrl === "string" ? body.assetUrl : null,
        source,
        typeof body.sourceUrl === "string" ? body.sourceUrl : null,
        reviewStatus,
        body.metadata != null ? JSON.stringify(body.metadata) : null,
        user?.id ?? null,
      ],
    );

    res.status(201).json(mapItem(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create library item" });
  }
});

libraryRouter.patch("/items/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Valid item id is required" });
      return;
    }

    const body = req.body as {
      category?: string;
      title?: string;
      description?: string;
      content?: string;
      assetUrl?: string;
      sourceUrl?: string;
      reviewStatus?: string;
      metadata?: unknown;
    };

    const updates: string[] = [];
    const params: unknown[] = [];

    if (body.category !== undefined) {
      if (!(LIBRARY_CATEGORIES as readonly string[]).includes(body.category)) {
        res.status(400).json({ error: `category must be one of: ${LIBRARY_CATEGORIES.join(", ")}` });
        return;
      }
      params.push(body.category);
      updates.push(`category = $${params.length}`);
    }
    if (body.reviewStatus !== undefined) {
      if (!(REVIEW_STATUSES as readonly string[]).includes(body.reviewStatus)) {
        res.status(400).json({ error: `reviewStatus must be one of: ${REVIEW_STATUSES.join(", ")}` });
        return;
      }
      params.push(body.reviewStatus);
      updates.push(`review_status = $${params.length}`);
    }
    if (body.title !== undefined) {
      params.push(body.title);
      updates.push(`title = $${params.length}`);
    }
    if (body.description !== undefined) {
      params.push(body.description);
      updates.push(`description = $${params.length}`);
    }
    if (body.content !== undefined) {
      params.push(body.content);
      updates.push(`content = $${params.length}`);
    }
    if (body.assetUrl !== undefined) {
      params.push(body.assetUrl);
      updates.push(`asset_url = $${params.length}`);
    }
    if (body.sourceUrl !== undefined) {
      params.push(body.sourceUrl);
      updates.push(`source_url = $${params.length}`);
    }
    if (body.metadata !== undefined) {
      params.push(body.metadata != null ? JSON.stringify(body.metadata) : null);
      updates.push(`metadata_json = $${params.length}`);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: "No updates provided" });
      return;
    }

    params.push(id);
    const { rows } = await pool.query<LibraryRow>(
      `UPDATE organization_library_items SET ${updates.join(", ")}
       WHERE id = $${params.length} RETURNING *`,
      params,
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Library item not found" });
      return;
    }

    res.json(mapItem(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update library item" });
  }
});

libraryRouter.delete("/items/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Valid item id is required" });
      return;
    }

    const { rowCount } = await pool.query(
      "DELETE FROM organization_library_items WHERE id = $1",
      [id],
    );

    if (!rowCount) {
      res.status(404).json({ error: "Library item not found" });
      return;
    }

    res.json({ success: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete library item" });
  }
});
