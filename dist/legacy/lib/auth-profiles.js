"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadUserNonprofitProfiles = loadUserNonprofitProfiles;
exports.loadUserBusinessProfiles = loadUserBusinessProfiles;
const pool_1 = require("../db/pool");
async function loadLatestAccessRequestStatus(organizationType, organizationId) {
    const client = await pool_1.pool.connect();
    try {
        await client.query("SET LOCAL statement_timeout = 3000");
        const { rows } = await client.query(`SELECT status
       FROM organization_access_requests
       WHERE organization_type = $1 AND organization_id = $2
       ORDER BY id DESC
       LIMIT 1`, [organizationType, organizationId]);
        const status = rows[0]?.status;
        if (status === "pending" || status === "approved" || status === "denied")
            return status;
        return null;
    }
    catch (err) {
        console.warn("loadLatestAccessRequestStatus failed:", err instanceof Error ? err.message : err);
        return null;
    }
    finally {
        client.release();
    }
}
function mapNonprofitRow(np) {
    return {
        id: np.id,
        organizationName: np.organization_name,
        slug: np.slug,
        mission: np.mission,
        website: np.website,
        contactName: np.contact_name,
        contactEmail: np.contact_email,
        contactPhone: np.contact_phone,
        causeCategory: np.cause_category,
        verificationStatus: np.verification_status,
        claimStatus: np.claim_status,
        profileStatus: np.profile_status ?? "preloaded",
        verified: np.verification_status === "verified",
    };
}
async function loadBusinessById(businessId) {
    const { rows: bizRows } = await pool_1.pool.query("SELECT * FROM businesses WHERE id = $1 LIMIT 1", [businessId]);
    if (bizRows.length === 0)
        return null;
    const biz = bizRows[0];
    const { rows: locations } = await pool_1.pool.query("SELECT * FROM business_locations WHERE business_id = $1 ORDER BY location_name", [biz.id]);
    const accessRequestStatus = await loadLatestAccessRequestStatus("business", businessId);
    return {
        id: biz.id,
        businessName: biz.business_name,
        slug: biz.slug,
        businessType: biz.business_type,
        website: biz.website,
        contactName: biz.contact_name,
        contactEmail: biz.contact_email,
        contactPhone: biz.contact_phone,
        businessStatus: biz.business_status,
        claimStatus: biz.claim_status,
        profileStatus: biz.profile_status ?? biz.business_status,
        defaultGivebackPercentage: biz.default_giveback_percentage != null ? Number(biz.default_giveback_percentage) : 10,
        capabilities: {
            dineAndDonate: Boolean(biz.supports_dine_and_donate),
            shopAndDonate: Boolean(biz.supports_shop_and_donate),
            serviceGiveback: Boolean(biz.supports_service_giveback),
            guestBartending: Boolean(biz.supports_guest_bartending),
        },
        locations: locations.map((l) => ({
            id: l.id,
            locationName: l.location_name,
            city: l.city,
            state: l.state,
            address: l.address,
        })),
        accessRequestStatus,
    };
}
async function loadNonprofitById(nonprofitId) {
    const client = await pool_1.pool.connect();
    try {
        await client.query("SET LOCAL statement_timeout = 8000");
        const { rows: rows } = await client.query("SELECT * FROM nonprofits WHERE id = $1 LIMIT 1", [nonprofitId]);
        if (rows.length === 0)
            return null;
        const profile = mapNonprofitRow(rows[0]);
        profile.accessRequestStatus = await loadLatestAccessRequestStatus("nonprofit", nonprofitId);
        return profile;
    }
    catch (err) {
        console.warn("loadNonprofitById failed:", err instanceof Error ? err.message : err);
        return null;
    }
    finally {
        client.release();
    }
}
async function loadUserNonprofitProfiles(user) {
    const seen = new Set();
    const profiles = [];
    for (const org of user.organizations.filter((o) => o.organizationType === "nonprofit")) {
        if (seen.has(org.organizationId))
            continue;
        const profile = await loadNonprofitById(org.organizationId);
        if (profile) {
            seen.add(org.organizationId);
            profiles.push(profile);
        }
    }
    if (profiles.length === 0) {
        const { rows: rows } = await pool_1.pool.query("SELECT * FROM nonprofits WHERE LOWER(contact_email) = $1 LIMIT 1", [user.email.toLowerCase()]);
        if (rows.length > 0) {
            const profile = mapNonprofitRow(rows[0]);
            profile.accessRequestStatus = await loadLatestAccessRequestStatus("nonprofit", Number(rows[0].id));
            profiles.push(profile);
        }
    }
    return profiles;
}
async function loadUserBusinessProfiles(user) {
    const seen = new Set();
    const profiles = [];
    for (const org of user.organizations.filter((o) => o.organizationType === "business")) {
        if (seen.has(org.organizationId))
            continue;
        const profile = await loadBusinessById(org.organizationId);
        if (profile) {
            seen.add(org.organizationId);
            profiles.push(profile);
        }
    }
    if (profiles.length === 0) {
        const { rows: bizRows } = await pool_1.pool.query("SELECT * FROM businesses WHERE LOWER(contact_email) = $1 LIMIT 1", [user.email.toLowerCase()]);
        if (bizRows.length > 0) {
            const profile = await loadBusinessById(bizRows[0].id);
            if (profile)
                profiles.push(profile);
        }
    }
    return profiles;
}
//# sourceMappingURL=auth-profiles.js.map