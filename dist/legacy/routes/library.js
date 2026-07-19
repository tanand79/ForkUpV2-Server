"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.libraryRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../lib/auth");
const pool_1 = require("../db/pool");
exports.libraryRouter = (0, express_1.Router)();
const ORG_TYPES = ["nonprofit", "business"];
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
];
const REVIEW_STATUSES = ["pending", "approved", "rejected", "ignored"];
const SOURCES = ["manual", "website_scan", "social_scan", "import"];
function isOrgType(value) {
    return ORG_TYPES.includes(value);
}
function mapItem(row) {
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
exports.libraryRouter.get("/:orgType/:orgId", async (req, res) => {
    try {
        const orgType = req.params.orgType;
        const orgId = Number(req.params.orgId);
        if (!isOrgType(orgType) || !orgId) {
            res.status(400).json({ error: "Valid organization type and id are required" });
            return;
        }
        const conditions = ["organization_type = $1", "organization_id = $2"];
        const params = [orgType, orgId];
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
        const { rows } = await pool_1.pool.query(`SELECT * FROM organization_library_items
       WHERE ${conditions.join(" AND ")}
       ORDER BY category ASC, id DESC`, params);
        res.json(rows.map(mapItem));
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch library items" });
    }
});
exports.libraryRouter.post("/:orgType/:orgId", async (req, res) => {
    try {
        const orgType = req.params.orgType;
        const orgId = Number(req.params.orgId);
        if (!isOrgType(orgType) || !orgId) {
            res.status(400).json({ error: "Valid organization type and id are required" });
            return;
        }
        const body = req.body;
        const category = typeof body.category === "string" ? body.category.trim() : "";
        if (!LIBRARY_CATEGORIES.includes(category)) {
            res.status(400).json({
                error: `category must be one of: ${LIBRARY_CATEGORIES.join(", ")}`,
            });
            return;
        }
        const source = typeof body.source === "string" && SOURCES.includes(body.source)
            ? body.source
            : "manual";
        const reviewStatus = typeof body.reviewStatus === "string" &&
            REVIEW_STATUSES.includes(body.reviewStatus)
            ? body.reviewStatus
            : "pending";
        const user = await (0, auth_1.resolveAuthUser)((0, auth_1.bearerToken)(req));
        const { rows } = await pool_1.pool.query(`INSERT INTO organization_library_items (
        organization_type, organization_id, category, title, description,
        content, asset_url, source, source_url, review_status, metadata_json,
        created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`, [
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
        ]);
        res.status(201).json(mapItem(rows[0]));
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create library item" });
    }
});
exports.libraryRouter.patch("/items/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id) {
            res.status(400).json({ error: "Valid item id is required" });
            return;
        }
        const body = req.body;
        const updates = [];
        const params = [];
        if (body.category !== undefined) {
            if (!LIBRARY_CATEGORIES.includes(body.category)) {
                res.status(400).json({ error: `category must be one of: ${LIBRARY_CATEGORIES.join(", ")}` });
                return;
            }
            params.push(body.category);
            updates.push(`category = $${params.length}`);
        }
        if (body.reviewStatus !== undefined) {
            if (!REVIEW_STATUSES.includes(body.reviewStatus)) {
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
        const { rows } = await pool_1.pool.query(`UPDATE organization_library_items SET ${updates.join(", ")}
       WHERE id = $${params.length} RETURNING *`, params);
        if (rows.length === 0) {
            res.status(404).json({ error: "Library item not found" });
            return;
        }
        res.json(mapItem(rows[0]));
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update library item" });
    }
});
exports.libraryRouter.delete("/items/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id) {
            res.status(400).json({ error: "Valid item id is required" });
            return;
        }
        const { rowCount } = await pool_1.pool.query("DELETE FROM organization_library_items WHERE id = $1", [id]);
        if (!rowCount) {
            res.status(404).json({ error: "Library item not found" });
            return;
        }
        res.json({ success: true, id });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete library item" });
    }
});
//# sourceMappingURL=library.js.map