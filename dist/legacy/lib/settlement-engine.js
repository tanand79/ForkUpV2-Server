"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settlementEngineSettings = settlementEngineSettings;
exports.closeExpiredCampaigns = closeExpiredCampaigns;
exports.freezeAdjustmentWindows = freezeAdjustmentWindows;
exports.createSnapshotsForFrozenCampaigns = createSnapshotsForFrozenCampaigns;
exports.createSnapshotForCampaign = createSnapshotForCampaign;
exports.updateSettlementAchStatus = updateSettlementAchStatus;
exports.runSettlementPipeline = runSettlementPipeline;
exports.lockCampaignForSettlement = lockCampaignForSettlement;
exports.campaignHasFrozenSnapshot = campaignHasFrozenSnapshot;
const pool_1 = require("../db/pool");
const financial_calculations_1 = require("./financial-calculations");
const mailer_1 = require("./mailer");
const money_format_1 = require("./money-format");
const settlement_ach_approval_1 = require("./settlement-ach-approval");
const settlement_pdf_1 = require("./settlement-pdf");
function settlementEngineSettings() {
    const envFlag = (process.env.SETTLEMENT_ENGINE_ENABLED ?? "true").trim().toLowerCase();
    return {
        intervalMinutes: Number(process.env.SETTLEMENT_INTERVAL_MINUTES || 30),
        adjustmentWindowHours: Number(process.env.SETTLEMENT_ADJUSTMENT_WINDOW_HOURS || 24),
        gracePeriodDays: Number(process.env.SETTLEMENT_GRACE_PERIOD_DAYS || 7),
        maxCampaignsPerCycle: Number(process.env.SETTLEMENT_MAX_CAMPAIGNS_PER_CYCLE || 5),
        platformFeePercent: Number(process.env.SETTLEMENT_PLATFORM_FEE_PERCENT || financial_calculations_1.DEFAULT_PLATFORM_FEE_PERCENT),
        cardFeePercent: Number(process.env.SETTLEMENT_CARD_FEE_PERCENT || 2.9),
        cardFeeFixed: Number(process.env.SETTLEMENT_CARD_FEE_FIXED || 0.3),
        enabled: envFlag !== "false" && envFlag !== "0",
    };
}
async function audit(campaignId, action, details, extra) {
    await pool_1.pool.query(`INSERT INTO settlement_audit_log
       (campaign_id, settlement_id, action, old_status, new_status, performed_by, details)
     VALUES ($1, $2, $3, $4, $5, 'SYSTEM', $6)`, [
        campaignId,
        extra?.settlementId ?? null,
        action,
        extra?.oldStatus ?? null,
        extra?.newStatus ?? null,
        details,
    ]);
}
async function hasAudit(campaignId, action) {
    const { rows } = await pool_1.pool.query(`SELECT 1 FROM settlement_audit_log WHERE campaign_id = $1 AND action = $2 LIMIT 1`, [campaignId, action]);
    return rows.length > 0;
}
function money(value) {
    return (0, money_format_1.formatMoneyUSD)(value);
}
async function loadPartners(campaignId) {
    const { rows } = await pool_1.pool.query(`SELECT cbl.business_id, cbl.location_id, cbl.giveback_percentage,
            b.business_name, b.contact_email,
            bl.location_name,
            ba.settlement_contact_email, ba.billing_contact_email,
            bl.ach_bank_name, bl.ach_account_holder_name, bl.ach_account_type, bl.ach_account_last4
     FROM campaign_business_locations cbl
     JOIN businesses b ON b.id = cbl.business_id
     JOIN business_locations bl ON bl.id = cbl.location_id
     LEFT JOIN business_acceptances ba ON ba.campaign_business_location_id = cbl.id
     WHERE cbl.campaign_id = $1
       AND cbl.acceptance_status = 'accepted'`, [campaignId]);
    return rows.map((r) => ({
        business_id: Number(r.business_id),
        location_id: Number(r.location_id),
        business_name: String(r.business_name ?? "Business"),
        location_name: String(r.location_name ?? "Location"),
        giveback_percentage: Number(r.giveback_percentage ?? 0),
        contact_email: typeof r.contact_email === "string" ? r.contact_email : null,
        settlement_contact_email: typeof r.settlement_contact_email === "string" ? r.settlement_contact_email : null,
        billing_contact_email: typeof r.billing_contact_email === "string" ? r.billing_contact_email : null,
        ach_bank_name: typeof r.ach_bank_name === "string" ? r.ach_bank_name : null,
        ach_account_holder_name: typeof r.ach_account_holder_name === "string" ? r.ach_account_holder_name : null,
        ach_account_type: typeof r.ach_account_type === "string" ? r.ach_account_type : null,
        ach_account_last4: typeof r.ach_account_last4 === "string" ? r.ach_account_last4 : null,
    }));
}
async function partnerReceiptTotals(campaignId, businessId, locationId) {
    const { rows } = await pool_1.pool.query(`SELECT COALESCE(SUM(COALESCE(eligible_subtotal, subtotal, 0)), 0) AS eligible_sales
     FROM receipts
     WHERE campaign_id = $1 AND business_id = $2 AND location_id = $3
       AND review_status = 'approved'`, [campaignId, businessId, locationId]);
    return { eligibleSales: Number(rows[0]?.eligible_sales ?? 0) };
}
async function virtualDonationTotals(campaignId) {
    const { rows } = await pool_1.pool.query(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS cnt
     FROM donations
     WHERE campaign_id = $1
       AND donation_type = 'virtual'
       AND payment_status = 'completed'`, [campaignId]);
    const amount = Number(rows[0]?.total ?? 0);
    return { amount, charged: amount, count: Number(rows[0]?.cnt ?? 0) };
}
async function upsertSnapshotRow(input) {
    const b = input.breakdown;
    const tips = Number(input.bartenderTips ?? 0);
    const auction = Number(input.silentAuction ?? 0);
    const manual = Math.round((tips + auction) * 100) / 100;
    const { rows: existing } = await pool_1.pool.query(input.businessId != null && input.locationId != null
        ? `SELECT id FROM settlements
         WHERE campaign_id = $1 AND business_id = $2 AND location_id = $3`
        : `SELECT id FROM settlements
         WHERE campaign_id = $1 AND business_id IS NULL AND location_id IS NULL`, input.businessId != null && input.locationId != null
        ? [input.campaignId, input.businessId, input.locationId]
        : [input.campaignId]);
    const values = [
        b.eligibleSales,
        input.donationPercentage,
        b.donationPool,
        b.forkupFee,
        b.netNonprofitAmount,
        b.grossGiveback,
        b.stripeDonations,
        b.stripeAmountCharged,
        b.stripeFee,
        b.stripeNet,
        b.platformFeePercent / 100,
        b.achDebitAmount,
        input.snapshotTime,
        tips,
        auction,
        manual,
    ];
    if (existing.length > 0) {
        await pool_1.pool.query(`UPDATE settlements SET
         eligible_sales = $1,
         donation_percentage = $2,
         donation_pool = $3,
         forkup_fee = $4,
         net_nonprofit_amount = $5,
         giveback_amount = $6,
         stripe_donations = $7,
         stripe_amount_charged = $8,
         stripe_fee = $9,
         stripe_net = $10,
         platform_fee_percent = $11,
         ach_debit_amount = $12,
         snapshot_created_at = $13,
         bartender_tips = $14,
         silent_auction = $15,
         manual_donations = $16,
         snapshot_status = 'SNAPSHOT_CREATED',
         ach_status = 'pending',
         locked_at = COALESCE(locked_at, $13),
         report_generated_at = $13
       WHERE id = $17`, [...values, existing[0].id]);
        return;
    }
    await pool_1.pool.query(`INSERT INTO settlements (
       campaign_id, business_id, location_id,
       eligible_sales, donation_percentage, donation_pool,
       forkup_fee, net_nonprofit_amount, payment_status,
       giveback_amount, stripe_donations, stripe_amount_charged,
       stripe_fee, stripe_net, platform_fee_percent, ach_debit_amount,
       snapshot_created_at, snapshot_status, ach_status, locked_at, report_generated_at,
       bartender_tips, silent_auction, manual_donations
     ) VALUES (
       $1, $2, $3,
       $4, $5, $6,
       $7, $8, 'pending',
       $9, $10, $11,
       $12, $13, $14, $15,
       $16, 'SNAPSHOT_CREATED', 'pending', $16, $16,
       $17, $18, $19
     )`, [
        input.campaignId,
        input.businessId,
        input.locationId,
        ...values,
    ]);
}
async function closeExpiredCampaigns(settings = settlementEngineSettings()) {
    const { rows } = await pool_1.pool.query(`SELECT id, campaign_name, campaign_status, campaign_end_date, settlement_grace_days
     FROM campaigns
     WHERE campaign_status = 'live'
       AND campaign_end_date IS NOT NULL
       AND (campaign_end_date::timestamp
            + (COALESCE(settlement_grace_days, $1) * INTERVAL '1 day')) < NOW()
       AND settlement_closed_at IS NULL
     ORDER BY campaign_end_date ASC
     LIMIT $2`, [settings.gracePeriodDays, settings.maxCampaignsPerCycle]);
    let closed = 0;
    for (const row of rows) {
        const now = new Date();
        const hours = settings.adjustmentWindowHours;
        const adjustmentEnd = new Date(now.getTime() + Math.max(hours, 0) * 60 * 60 * 1000);
        const grace = Number(row.settlement_grace_days ?? settings.gracePeriodDays);
        await pool_1.pool.query(`UPDATE campaigns SET
         campaign_status = 'closed',
         settlement_closed_at = $1,
         adjustment_window_end = $2,
         settlement_closed_by = 'SYSTEM',
         updated_at = NOW()
       WHERE id = $3`, [now, adjustmentEnd, row.id]);
        await audit(Number(row.id), "CAMPAIGN_CLOSED", `Campaign closed (grace period: ${grace} days). Adjustment window (${hours} hour(s)) until ${adjustmentEnd.toISOString()}`, { oldStatus: "live", newStatus: "closed" });
        closed += 1;
        console.log(`[settlement-engine] Closed campaign ${row.id} "${row.campaign_name}". Adjustment ends ${adjustmentEnd.toISOString()}`);
    }
    return closed;
}
async function freezeAdjustmentWindows(settings = settlementEngineSettings()) {
    const { rows } = await pool_1.pool.query(`SELECT id, campaign_name
     FROM campaigns
     WHERE campaign_status = 'closed'
       AND settlement_closed_at IS NOT NULL
       AND settlement_frozen_at IS NULL
       AND adjustment_window_end IS NOT NULL
       AND adjustment_window_end < NOW()
     ORDER BY adjustment_window_end ASC
     LIMIT $1`, [settings.maxCampaignsPerCycle]);
    let frozen = 0;
    for (const row of rows) {
        await pool_1.pool.query(`UPDATE campaigns SET
         campaign_status = 'settlement',
         settlement_frozen_at = NOW(),
         updated_at = NOW()
       WHERE id = $1`, [row.id]);
        await audit(Number(row.id), "CAMPAIGN_FROZEN", "Adjustment window expired. Campaign locked permanently.", {
            oldStatus: "closed",
            newStatus: "settlement",
        });
        frozen += 1;
        console.log(`[settlement-engine] Frozen campaign ${row.id} "${row.campaign_name}"`);
    }
    return frozen;
}
async function createSnapshotsForFrozenCampaigns(settings = settlementEngineSettings()) {
    const { rows } = await pool_1.pool.query(`SELECT c.id, c.campaign_name
     FROM campaigns c
     WHERE c.settlement_frozen_at IS NOT NULL
       AND c.campaign_status = 'settlement'
       AND NOT EXISTS (
         SELECT 1 FROM settlements s
         WHERE s.campaign_id = c.id AND s.snapshot_created_at IS NOT NULL
       )
     ORDER BY c.settlement_frozen_at ASC
     LIMIT $1`, [settings.maxCampaignsPerCycle]);
    let count = 0;
    for (const row of rows) {
        await createSnapshotForCampaign(Number(row.id), settings);
        count += 1;
    }
    return count;
}
async function createSnapshotForCampaign(campaignId, settings = settlementEngineSettings()) {
    const { rows: campaignRows } = await pool_1.pool.query(`SELECT platform_fee_percent, card_fee_percent, card_fee_fixed,
            bartender_tips, silent_auction
     FROM campaigns WHERE id = $1`, [campaignId]);
    const camp = campaignRows[0] ?? {};
    const feePct = (0, financial_calculations_1.normalizePlatformFeePercent)(camp.platform_fee_percent != null ? Number(camp.platform_fee_percent) : null, settings.platformFeePercent);
    const cardPct = (0, financial_calculations_1.normalizeCardFeePercent)(camp.card_fee_percent != null ? Number(camp.card_fee_percent) : null, settings.cardFeePercent);
    const cardFixed = camp.card_fee_fixed != null && Number(camp.card_fee_fixed) >= 0
        ? Number(camp.card_fee_fixed)
        : settings.cardFeeFixed;
    const bartenderTips = Number(camp.bartender_tips ?? 0);
    const silentAuction = Number(camp.silent_auction ?? 0);
    const partners = await loadPartners(campaignId);
    const virtual = await virtualDonationTotals(campaignId);
    const snapshotTime = new Date();
    for (const partner of partners) {
        const { eligibleSales } = await partnerReceiptTotals(campaignId, partner.business_id, partner.location_id);
        const breakdown = (0, financial_calculations_1.calculateSettlementSnapshot)({
            eligibleSales,
            givebackPercentage: partner.giveback_percentage,
            platformFeePercent: feePct,
        });
        await upsertSnapshotRow({
            campaignId,
            businessId: partner.business_id,
            locationId: partner.location_id,
            donationPercentage: partner.giveback_percentage,
            breakdown,
            snapshotTime,
        });
    }
    const virtualBreakdown = (0, financial_calculations_1.calculateSettlementSnapshot)({
        eligibleSales: 0,
        givebackPercentage: 0,
        platformFeePercent: feePct,
        stripeDonations: virtual.amount,
        stripeAmountCharged: virtual.charged,
        stripeDonationCount: virtual.count,
        cardFeePercent: cardPct,
        cardFeeFixed: cardFixed,
    });
    if (virtual.count > 0 || partners.length === 0 || bartenderTips > 0 || silentAuction > 0) {
        await upsertSnapshotRow({
            campaignId,
            businessId: null,
            locationId: null,
            donationPercentage: 0,
            breakdown: virtualBreakdown,
            snapshotTime,
            bartenderTips,
            silentAuction,
        });
    }
    await audit(campaignId, "SNAPSHOT_CREATED", "Immutable settlement snapshot created.", {
        oldStatus: "LOCKED",
        newStatus: "SNAPSHOT_CREATED",
    });
    console.log(`[settlement-engine] Snapshot created for campaign ${campaignId}`);
}
const ACH_STATUSES = ["pending", "processing", "paid", "failed"];
async function updateSettlementAchStatus(input) {
    const next = input.achStatus.trim().toLowerCase();
    if (!ACH_STATUSES.includes(next)) {
        throw new Error("ACH status must be pending, processing, paid, or failed");
    }
    const { rows } = await pool_1.pool.query(`SELECT id, ach_status FROM settlements WHERE id = $1 AND campaign_id = $2`, [input.settlementId, input.campaignId]);
    if (rows.length === 0) {
        throw new Error("Settlement not found");
    }
    const previous = String(rows[0].ach_status ?? "pending");
    await pool_1.pool.query(`UPDATE settlements SET ach_status = $1 WHERE id = $2`, [
        next,
        input.settlementId,
    ]);
    await audit(input.campaignId, "ACH_STATUS_UPDATED", `ACH status ${previous} → ${next}`, {
        oldStatus: previous,
        newStatus: next,
        settlementId: input.settlementId,
    });
    return { achStatus: next };
}
async function loadCampaignContext(campaignId) {
    const { rows } = await pool_1.pool.query(`SELECT c.id, c.slug, c.campaign_name, c.campaign_start_date, c.campaign_end_date,
            n.organization_name, n.contact_email AS nonprofit_email, n.ein
     FROM campaigns c
     JOIN nonprofits n ON n.id = c.nonprofit_id
     WHERE c.id = $1`, [campaignId]);
    if (!rows[0])
        return null;
    const r = rows[0];
    return {
        id: Number(r.id),
        slug: String(r.slug),
        campaign_name: String(r.campaign_name),
        organization_name: String(r.organization_name),
        nonprofit_email: typeof r.nonprofit_email === "string" ? r.nonprofit_email : null,
        nonprofit_ein: typeof r.ein === "string" ? r.ein : null,
        start_date: r.campaign_start_date ? String(r.campaign_start_date).slice(0, 10) : null,
        end_date: r.campaign_end_date ? String(r.campaign_end_date).slice(0, 10) : null,
    };
}
async function sendClosedEmails(settings = settlementEngineSettings()) {
    const { rows } = await pool_1.pool.query(`SELECT c.id
     FROM campaigns c
     WHERE c.settlement_closed_at IS NOT NULL
       AND c.settlement_frozen_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM settlement_audit_log a
         WHERE a.campaign_id = c.id AND a.action = 'CLOSE_EMAIL_SENT'
       )
     ORDER BY c.settlement_closed_at DESC
     LIMIT $1`, [settings.maxCampaignsPerCycle]);
    let sent = 0;
    for (const row of rows) {
        const campaignId = Number(row.id);
        const ctx = await loadCampaignContext(campaignId);
        if (!ctx)
            continue;
        const reportUrl = `${(0, mailer_1.resolveFrontendBaseUrl)()}/?step=reporting&campaign=${ctx.slug}`;
        const partners = await loadPartners(campaignId);
        const windowNote = `A ${settings.adjustmentWindowHours}-hour adjustment window is open for final receipt approvals.`;
        for (const p of partners) {
            const to = p.settlement_contact_email?.trim() ||
                p.billing_contact_email?.trim() ||
                p.contact_email?.trim() ||
                "";
            if (!to)
                continue;
            await (0, mailer_1.sendEmail)({
                to,
                name: p.business_name,
                subject: `Campaign closed — adjustment window open for "${ctx.campaign_name}"`,
                body: `Hi ${p.business_name},\n\n` +
                    `The campaign "${ctx.campaign_name}" for ${ctx.organization_name} has ended and is now closed.\n\n` +
                    `${windowNote}\n` +
                    `After the window, totals are frozen and settlement statements are generated.\n\n` +
                    `Report: ${reportUrl}\n\n— ForkUp`,
                emailType: "settlement_campaign_closed",
                campaignId,
                stakeholderRole: "business",
                relatedToken: `settlement-close:${campaignId}:${p.business_id}`,
                onlyOnce: true,
                platformSender: true,
            });
        }
        if (ctx.nonprofit_email?.includes("@")) {
            await (0, mailer_1.sendEmail)({
                to: ctx.nonprofit_email,
                name: ctx.organization_name,
                subject: `Campaign closed — "${ctx.campaign_name}"`,
                body: `Hi ${ctx.organization_name},\n\n` +
                    `Your campaign "${ctx.campaign_name}" is closed. ${windowNote}\n\n` +
                    `Report: ${reportUrl}\n\n— ForkUp`,
                emailType: "settlement_campaign_closed_npo",
                campaignId,
                stakeholderRole: "nonprofit",
                relatedToken: `settlement-close:${campaignId}:nonprofit`,
                onlyOnce: true,
                platformSender: true,
            });
        }
        await audit(campaignId, "CLOSE_EMAIL_SENT", "Campaign closed emails sent.");
        sent += 1;
    }
    return sent;
}
async function sendFreezeEmails(settings = settlementEngineSettings()) {
    const { rows } = await pool_1.pool.query(`SELECT c.id
     FROM campaigns c
     WHERE c.settlement_frozen_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM settlement_audit_log a
         WHERE a.campaign_id = c.id AND a.action = 'FREEZE_EMAIL_SENT'
       )
     ORDER BY c.settlement_frozen_at DESC
     LIMIT $1`, [settings.maxCampaignsPerCycle]);
    let sent = 0;
    for (const row of rows) {
        const campaignId = Number(row.id);
        const ctx = await loadCampaignContext(campaignId);
        if (!ctx)
            continue;
        const reportUrl = `${(0, mailer_1.resolveFrontendBaseUrl)()}/?step=reporting&campaign=${ctx.slug}`;
        const partners = await loadPartners(campaignId);
        for (const p of partners) {
            const to = p.settlement_contact_email?.trim() ||
                p.billing_contact_email?.trim() ||
                p.contact_email?.trim() ||
                "";
            if (!to)
                continue;
            await (0, mailer_1.sendEmail)({
                to,
                name: p.business_name,
                subject: `Campaign frozen — settlement in progress for "${ctx.campaign_name}"`,
                body: `Hi ${p.business_name},\n\n` +
                    `The adjustment window has ended. Totals for "${ctx.campaign_name}" are now locked.\n` +
                    `Settlement statements will follow shortly.\n\n` +
                    `Report: ${reportUrl}\n\n— ForkUp`,
                emailType: "settlement_campaign_frozen",
                campaignId,
                stakeholderRole: "business",
                relatedToken: `settlement-freeze:${campaignId}:${p.business_id}`,
                onlyOnce: true,
                platformSender: true,
            });
        }
        if (ctx.nonprofit_email?.includes("@")) {
            await (0, mailer_1.sendEmail)({
                to: ctx.nonprofit_email,
                name: ctx.organization_name,
                subject: `Campaign frozen — "${ctx.campaign_name}"`,
                body: `Hi ${ctx.organization_name},\n\n` +
                    `Totals for "${ctx.campaign_name}" are locked. Settlement statements will be emailed next.\n\n` +
                    `Report: ${reportUrl}\n\n— ForkUp`,
                emailType: "settlement_campaign_frozen_npo",
                campaignId,
                stakeholderRole: "nonprofit",
                relatedToken: `settlement-freeze:${campaignId}:nonprofit`,
                onlyOnce: true,
                platformSender: true,
            });
        }
        await audit(campaignId, "FREEZE_EMAIL_SENT", "Campaign frozen notification emails sent.");
        sent += 1;
    }
    return sent;
}
async function generateStatementsAndEmail(settings = settlementEngineSettings()) {
    const { rows } = await pool_1.pool.query(`SELECT c.id
     FROM campaigns c
     WHERE c.settlement_frozen_at IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM settlements s
         WHERE s.campaign_id = c.id AND s.snapshot_created_at IS NOT NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM settlement_audit_log a
         WHERE a.campaign_id = c.id AND a.action = 'SETTLEMENT_EMAIL_SENT'
       )
     ORDER BY c.settlement_frozen_at ASC
     LIMIT $1`, [settings.maxCampaignsPerCycle]);
    let emailed = 0;
    for (const row of rows) {
        try {
            await generateAndEmailForCampaign(Number(row.id));
            emailed += 1;
        }
        catch (err) {
            console.error(`[settlement-engine] PDF/email failed for campaign ${row.id}`, err);
        }
    }
    return emailed;
}
async function generateAndEmailForCampaign(campaignId) {
    const ctx = await loadCampaignContext(campaignId);
    if (!ctx)
        return;
    const partners = await loadPartners(campaignId);
    const { rows: settlements } = await pool_1.pool.query(`SELECT s.*, b.business_name, bl.location_name
     FROM settlements s
     LEFT JOIN businesses b ON b.id = s.business_id
     LEFT JOIN business_locations bl ON bl.id = s.location_id
     WHERE s.campaign_id = $1
     ORDER BY b.business_name NULLS LAST, bl.location_name NULLS LAST`, [campaignId]);
    const totals = settlements.reduce((acc, s) => ({
        eligibleSales: acc.eligibleSales + Number(s.eligible_sales ?? 0),
        giveback: acc.giveback + Number(s.giveback_amount ?? s.donation_pool ?? 0),
        fee: acc.fee + Number(s.forkup_fee ?? 0),
        net: acc.net + Number(s.net_nonprofit_amount ?? 0),
        stripe: acc.stripe + Number(s.stripe_donations ?? 0),
        stripeFee: acc.stripeFee + Number(s.stripe_fee ?? 0),
        stripeNet: acc.stripeNet + Number(s.stripe_net ?? 0),
        ach: acc.ach + Number(s.ach_debit_amount ?? 0),
    }), {
        eligibleSales: 0,
        giveback: 0,
        fee: 0,
        net: 0,
        stripe: 0,
        stripeFee: 0,
        stripeNet: 0,
        ach: 0,
    });
    const header = [
        `Campaign: ${ctx.campaign_name}`,
        `Nonprofit: ${ctx.organization_name}${ctx.nonprofit_ein ? `  EIN ${ctx.nonprofit_ein}` : ""}`,
        `Dates: ${ctx.start_date ?? "—"} to ${ctx.end_date ?? "—"}`,
        `Generated: ${new Date().toISOString()}`,
        "",
    ];
    const nonprofitLines = [
        ...header,
        (0, settlement_pdf_1.moneyLine)("Eligible sales (Dine & Donate / giveback)", totals.eligibleSales),
        (0, settlement_pdf_1.moneyLine)("Gross giveback", totals.giveback),
        (0, settlement_pdf_1.moneyLine)("Online (virtual) donations", totals.stripe),
        (0, settlement_pdf_1.moneyLine)("Card processing fees", totals.stripeFee),
        (0, settlement_pdf_1.moneyLine)("Online net", totals.stripeNet),
        (0, settlement_pdf_1.moneyLine)("ForkUp platform fee", totals.fee),
        (0, settlement_pdf_1.moneyLine)("Net due to nonprofit", totals.net),
        "",
        "By partner:",
        ...settlements.map((s) => {
            const name = s.business_id
                ? `${s.business_name ?? "Business"} — ${s.location_name ?? ""}`
                : "Online donations";
            return `  ${name}: sales ${money(s.eligible_sales)}  giveback ${money(s.giveback_amount)}  fee ${money(s.forkup_fee)}  net ${money(s.net_nonprofit_amount)}`;
        }),
    ];
    const internalLines = [
        ...nonprofitLines,
        "",
        (0, settlement_pdf_1.moneyLine)("ACH debit (ForkUp fees from businesses)", totals.ach),
        "ACH is submitted manually via the bank portal. Track status on the settlement report.",
    ];
    const nonprofitPdf = (0, settlement_pdf_1.writeSettlementPdf)(campaignId, "nonprofit-donation-statement.pdf", "ForkUp Nonprofit Donation Statement", nonprofitLines);
    const internalPdf = (0, settlement_pdf_1.writeSettlementPdf)(campaignId, "internal-settlement-report.pdf", "ForkUp Internal Settlement Report (Confidential)", internalLines);
    const reportUrl = `${(0, mailer_1.resolveFrontendBaseUrl)()}/?step=reporting&campaign=${ctx.slug}`;
    const apiBase = (0, mailer_1.resolveFrontendBaseUrl)();
    for (const s of settlements) {
        if (!s.business_id)
            continue;
        const partner = partners.find((p) => p.business_id === Number(s.business_id) && p.location_id === Number(s.location_id));
        const bizLines = [
            ...header,
            `Business: ${s.business_name ?? partner?.business_name ?? ""}`,
            `Location: ${s.location_name ?? partner?.location_name ?? ""}`,
            "",
            (0, settlement_pdf_1.moneyLine)("Eligible sales", Number(s.eligible_sales)),
            `Giveback %: ${Number(s.donation_percentage).toFixed(2)}%`,
            (0, settlement_pdf_1.moneyLine)("Gross giveback", Number(s.giveback_amount ?? s.donation_pool)),
            (0, settlement_pdf_1.moneyLine)("ForkUp fee", Number(s.forkup_fee)),
            (0, settlement_pdf_1.moneyLine)("Net due to nonprofit", Number(s.net_nonprofit_amount)),
            (0, settlement_pdf_1.moneyLine)("ACH debit (platform fee)", Number(s.ach_debit_amount ?? s.forkup_fee)),
            "",
            `Bank: ${partner?.ach_bank_name ?? "—"}`,
            `Account holder: ${partner?.ach_account_holder_name ?? "—"}`,
            `Account type: ${partner?.ach_account_type ?? "—"}`,
            `Account last 4: ${partner?.ach_account_last4 ?? "—"}`,
        ];
        const bizPdf = (0, settlement_pdf_1.writeSettlementPdf)(campaignId, `business-${s.business_id}-${s.location_id}.pdf`, "ForkUp Business Settlement Statement", bizLines);
        const achPdf = (0, settlement_pdf_1.writeSettlementPdf)(campaignId, `ach-${s.business_id}-${s.location_id}.pdf`, "ForkUp ACH Debit Authorization", [
            ...header,
            `Debit ${money(s.ach_debit_amount ?? s.forkup_fee)} from ${partner?.ach_bank_name ?? "authorized account"}`,
            `Account ****${partner?.ach_account_last4 ?? "————"}`,
            "Authorization is on file from campaign acceptance.",
        ]);
        await pool_1.pool.query(`UPDATE settlements SET
         pdf_business_path = $1,
         pdf_nonprofit_path = $2,
         pdf_internal_path = $3,
         pdf_ach_path = $4,
         ach_status = 'pending',
         snapshot_status = 'STATEMENTS_SENT'
       WHERE id = $5`, [bizPdf, nonprofitPdf, internalPdf, achPdf, s.id]);
        const to = partner?.settlement_contact_email?.trim() ||
            partner?.billing_contact_email?.trim() ||
            partner?.contact_email?.trim() ||
            "";
        if (!to)
            continue;
        const debitAmount = Number(s.ach_debit_amount ?? s.forkup_fee ?? 0);
        const approvalToken = await (0, settlement_ach_approval_1.ensureSettlementAchApproval)({
            settlementId: Number(s.id),
            campaignId,
            approvalType: "business_debit",
            amount: debitAmount,
        });
        const approvalUrl = (0, settlement_ach_approval_1.settlementAchApprovalUrl)(approvalToken, (0, mailer_1.resolveFrontendBaseUrl)());
        await (0, mailer_1.sendEmail)({
            to,
            name: String(s.business_name ?? partner?.business_name ?? ""),
            subject: `Settlement Statement - ${ctx.campaign_name}`,
            body: `Hi ${s.business_name ?? partner?.business_name},\n\n` +
                `Settlement for "${ctx.campaign_name}" is complete.\n\n` +
                `Eligible sales: ${money(s.eligible_sales)}\n` +
                `Giveback: ${money(s.giveback_amount ?? s.donation_pool)}\n` +
                `ForkUp fee (ACH debit): ${money(s.forkup_fee)}\n` +
                `Net to ${ctx.organization_name}: ${money(s.net_nonprofit_amount)}\n\n` +
                `Approve ACH debit (${money(debitAmount)}): ${approvalUrl}\n\n` +
                `Business statement: ${apiBase}${bizPdf}\n` +
                `ACH form: ${apiBase}${achPdf}\n` +
                `Report: ${reportUrl}\n\n— ForkUp`,
            emailType: "settlement_business",
            campaignId,
            stakeholderRole: "business",
            relatedToken: `settlement:${campaignId}:${s.business_id}`,
            onlyOnce: true,
            platformSender: true,
        });
    }
    await pool_1.pool.query(`UPDATE settlements SET
       pdf_nonprofit_path = COALESCE(pdf_nonprofit_path, $1),
       pdf_internal_path = COALESCE(pdf_internal_path, $2),
       snapshot_status = 'STATEMENTS_SENT'
     WHERE campaign_id = $3 AND business_id IS NULL`, [nonprofitPdf, internalPdf, campaignId]);
    if (ctx.nonprofit_email?.includes("@")) {
        const onlineRow = settlements.find((s) => s.business_id == null);
        let onlineApprovalLine = "";
        if (onlineRow && totals.stripeNet > 0) {
            const payoutToken = await (0, settlement_ach_approval_1.ensureSettlementAchApproval)({
                settlementId: Number(onlineRow.id),
                campaignId,
                approvalType: "nonprofit_payout",
                amount: totals.stripeNet,
            });
            const payoutUrl = (0, settlement_ach_approval_1.settlementAchApprovalUrl)(payoutToken, (0, mailer_1.resolveFrontendBaseUrl)());
            onlineApprovalLine =
                `\nApprove online donation payout (${money(totals.stripeNet)}): ${payoutUrl}\n`;
        }
        await (0, mailer_1.sendEmail)({
            to: ctx.nonprofit_email,
            name: ctx.organization_name,
            subject: `Settlement Statement - ${ctx.campaign_name}`,
            body: `Hi ${ctx.organization_name},\n\n` +
                `Settlement for "${ctx.campaign_name}" is ready.\n\n` +
                `Expected from businesses (net): ${money(totals.net - totals.stripeNet)}\n` +
                `Online donations (net after card fees): ${money(totals.stripeNet)}\n` +
                `Total net: ${money(totals.net)}\n` +
                onlineApprovalLine +
                `\nDonation statement: ${apiBase}${nonprofitPdf}\n` +
                `Report: ${reportUrl}\n\n— ForkUp`,
            emailType: "settlement_nonprofit",
            campaignId,
            stakeholderRole: "nonprofit",
            relatedToken: `settlement:${campaignId}:nonprofit`,
            onlyOnce: true,
            platformSender: true,
        });
    }
    const adminEmail = process.env.FORKUP_ADMIN_EMAIL?.trim();
    if (adminEmail) {
        await (0, mailer_1.sendEmail)({
            to: adminEmail,
            subject: `[Internal] Settlement Statement - ${ctx.campaign_name}`,
            body: `Campaign "${ctx.campaign_name}" (${ctx.organization_name}) settlement PDFs generated.\n\n` +
                `ForkUp fees (ACH): ${money(totals.ach)}\n` +
                `Net to nonprofit: ${money(totals.net)}\n` +
                `Online donations: ${money(totals.stripe)}\n\n` +
                `Internal report: ${apiBase}${internalPdf}\n` +
                `Report: ${reportUrl}\n`,
            emailType: "settlement_internal",
            campaignId,
            stakeholderRole: "admin",
            relatedToken: `settlement:${campaignId}:internal`,
            onlyOnce: true,
            platformSender: true,
        });
    }
    await audit(campaignId, "SETTLEMENT_EMAIL_SENT", "Settlement PDFs generated and emailed. No more emails will be sent for this campaign.");
}
async function runSettlementPipeline() {
    const settings = settlementEngineSettings();
    const errors = [];
    let closed = 0;
    let frozen = 0;
    let snapshots = 0;
    let emailed = 0;
    try {
        closed = await closeExpiredCampaigns(settings);
    }
    catch (err) {
        errors.push(`close: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        await sendClosedEmails(settings);
    }
    catch (err) {
        errors.push(`close-email: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        frozen = await freezeAdjustmentWindows(settings);
    }
    catch (err) {
        errors.push(`freeze: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        await sendFreezeEmails(settings);
    }
    catch (err) {
        errors.push(`freeze-email: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        snapshots = await createSnapshotsForFrozenCampaigns(settings);
    }
    catch (err) {
        errors.push(`snapshot: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        emailed = await generateStatementsAndEmail(settings);
    }
    catch (err) {
        errors.push(`statements: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { closed, frozen, snapshots, emailed, errors };
}
async function lockCampaignForSettlement(campaignId) {
    const settings = settlementEngineSettings();
    const { rows } = await pool_1.pool.query(`SELECT id, campaign_status, settlement_frozen_at FROM campaigns WHERE id = $1`, [campaignId]);
    if (!rows[0])
        throw new Error("Campaign not found");
    if (rows[0].campaign_status === "settlement" && rows[0].settlement_frozen_at) {
        throw new Error("Campaign is already locked for settlement");
    }
    const now = new Date();
    await pool_1.pool.query(`UPDATE campaigns SET
       campaign_status = 'settlement',
       settlement_closed_at = COALESCE(settlement_closed_at, $1),
       settlement_frozen_at = $1,
       adjustment_window_end = COALESCE(adjustment_window_end, $1),
       settlement_closed_by = COALESCE(settlement_closed_by, 'MANUAL'),
       updated_at = NOW()
     WHERE id = $2`, [now, campaignId]);
    if (!(await hasAudit(campaignId, "CAMPAIGN_CLOSED"))) {
        await audit(campaignId, "CAMPAIGN_CLOSED", "Campaign closed via manual lock.", {
            oldStatus: String(rows[0].campaign_status),
            newStatus: "closed",
        });
    }
    if (!(await hasAudit(campaignId, "CAMPAIGN_FROZEN"))) {
        await audit(campaignId, "CAMPAIGN_FROZEN", "Campaign frozen via manual lock.", {
            oldStatus: "closed",
            newStatus: "settlement",
        });
    }
    const { rows: existingSnap } = await pool_1.pool.query(`SELECT 1 FROM settlements WHERE campaign_id = $1 AND snapshot_created_at IS NOT NULL LIMIT 1`, [campaignId]);
    if (existingSnap.length === 0) {
        await createSnapshotForCampaign(campaignId, settings);
    }
    if (!(await hasAudit(campaignId, "SETTLEMENT_EMAIL_SENT"))) {
        await generateAndEmailForCampaign(campaignId);
    }
}
async function campaignHasFrozenSnapshot(campaignId) {
    const { rows } = await pool_1.pool.query(`SELECT 1 FROM campaigns c
     WHERE c.id = $1 AND c.settlement_frozen_at IS NOT NULL
     LIMIT 1`, [campaignId]);
    return rows.length > 0;
}
//# sourceMappingURL=settlement-engine.js.map