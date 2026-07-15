/**
 * Automated smoke test for ForkUp phases 1–6 (API + web HTTP checks).
 * Run: node scripts/phase-test.mjs
 */
const API = "http://localhost:3001";
const WEB = "http://localhost:3000";
const SEED_SLUG = "sovana-dine-and-donate-spring";
const ts = Date.now();
const testEmail = `phase-test-${ts}@forkup.test`;

const results = [];

function pass(phase, name, detail = "") {
  results.push({ phase, name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(phase, name, detail = "") {
  results.push({ phase, name, ok: false, detail });
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

async function webGet(path) {
  const res = await fetch(`${WEB}${path}`);
  return { status: res.status, ok: res.ok };
}

async function run() {
  console.log("\n=== ForkUp phase tests ===\n");
  let token = null;
  let newSlug = null;
  let inviteToken = null;
  let nonprofitInviteToken = null;
  let participantId = null;
  let successActionId = null;
  let receiptId = null;
  let nonprofitId = null;
  let businessId = null;
  let locationId = null;

  // --- Phase 1 ---
  console.log("Phase 1 — Foundation, profiles, builder");
  try {
    const health = await api("GET", "/api/health");
    if (health.status === 200 && health.json?.status === "ok") {
      pass("1", "API health", `db: ${health.json.databaseTarget}`);
    } else fail("1", "API health", `status ${health.status}`);

    const businesses = await api("GET", "/api/builder/businesses");
    if (businesses.status === 200 && Array.isArray(businesses.json) && businesses.json.length > 0) {
      pass("1", "Builder businesses", `${businesses.json.length} businesses`);
      const first = businesses.json[0];
      businessId = first.id;
      locationId = first.locations?.[0]?.id;
    } else fail("1", "Builder businesses");

    const claim = await api("POST", "/api/profiles/nonprofits/claim", {
      organizationName: `Phase Test Org ${ts}`,
      contactName: "Test User",
      contactEmail: testEmail,
      mission: "Automated test nonprofit",
      causeCategory: "Education",
    });
    if ((claim.status === 200 || claim.status === 201) && claim.json?.nonprofit?.id) {
      pass("1", "Nonprofit claim", `id ${claim.json.nonprofit.id}`);
      nonprofitId = claim.json.nonprofit.id;
    } else fail("1", "Nonprofit claim", JSON.stringify(claim.json));

    const readiness = await api("GET", `/api/profiles/nonprofits/readiness?email=${encodeURIComponent(testEmail)}`);
    if (readiness.status === 200 && readiness.json?.state) {
      pass("1", "Nonprofit readiness", readiness.json.state);
    } else fail("1", "Nonprofit readiness");

    const biz = businesses.json?.[0];
    const create = await api("POST", "/api/builder/campaigns", {
      nonprofit: {
        organizationName: `Phase Test Org ${ts}`,
        contactName: "Test User",
        contactEmail: testEmail,
        mission: "Test",
        causeCategory: "Education",
      },
      campaignName: `Phase Test Campaign ${ts}`,
      campaignStory: "Automated end-to-end test campaign story with enough content.",
      campaignGoal: 5000,
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      coverImage: "/images/campaigns/default.jpg",
      methods: ["virtual_donations", "dine_and_donate", "guest_bartending_event", "ambassador_fundraising"],
      invitations: biz
        ? [
            {
              businessId: biz.id,
              locationId: biz.locations[0].id,
              methodType: "dine_and_donate",
              givebackPercentage: 15,
            },
          ]
        : [],
      termsAccepted: true,
      launch: true,
    });
    if (create.status === 201 && create.json?.slug) {
      newSlug = create.json.slug;
      inviteToken = create.json.invitationLinks?.[0]?.token ?? null;
      pass("1", "Campaign create + launch", `slug ${newSlug}`);
    } else fail("1", "Campaign create + launch", JSON.stringify(create.json));
  } catch (e) {
    fail("1", "Phase 1 exception", String(e.message));
  }

  // --- Phase 2 ---
  console.log("\nPhase 2 — Business acceptance, dashboard, donations");
  try {
    const slug = newSlug || SEED_SLUG;
    const dash = await api("GET", `/api/manage/campaigns/${slug}`);
    if (dash.status === 200 && (dash.json?.campaignName || dash.json?.name)) {
      pass("2", "Campaign dashboard", dash.json.campaignName);
    } else fail("2", "Campaign dashboard");

    if (inviteToken) {
      const invGet = await api("GET", `/api/business/invitations/${inviteToken}`);
      if (invGet.status === 200) pass("2", "Business invitation load");
      else fail("2", "Business invitation load", `status ${invGet.status}`);

      const unauthAccept = await api("POST", `/api/business/invitations/${inviteToken}/accept`, {
        authorizedRepresentative: "Test Manager",
        forkupFeeAcknowledged: true,
        net7Acknowledged: true,
        achAuthorized: true,
      });
      if (unauthAccept.status === 401) pass("2", "Business invite requires auth");
      else fail("2", "Business invite requires auth", `status ${unauthAccept.status}`);

      const bizEmail = invGet.json?.business?.email ?? biz?.contactEmail ?? "ops@sovanabistro.com";
      const bizPassword = "phase-test-password";
      let bizToken = null;
      const bizReg = await api("POST", "/api/auth/register", {
        email: bizEmail,
        password: bizPassword,
        fullName: "Test Manager",
        organizationType: "business",
        organizationId: biz?.id,
      });
      if (bizReg.status === 201) bizToken = bizReg.json?.token;
      else {
        const bizLogin = await api("POST", "/api/auth/login", {
          email: bizEmail,
          password: bizPassword,
        });
        if (bizLogin.status === 200) bizToken = bizLogin.json?.token;
      }
      if (!bizToken) fail("2", "Business auth for invite", `email ${bizEmail}`);
      else pass("2", "Business auth for invite", bizEmail);

      const invAccept = await api(
        "POST",
        `/api/business/invitations/${inviteToken}/accept`,
        {
          authorizedRepresentative: "Test Manager",
          forkupFeeAcknowledged: true,
          net7Acknowledged: true,
          achAuthorized: true,
          billingContactName: "Billing",
          billingContactEmail: "billing@test.com",
          settlementContactName: "Settlement",
          settlementContactEmail: "settlement@test.com",
        },
        bizToken,
      );
      if (invAccept.status === 200) pass("2", "Business invitation accept");
      else fail("2", "Business invitation accept", JSON.stringify(invAccept.json));
    } else {
      fail("2", "Business invitation flow", "no invite token from create");
    }

    const donate = await api("POST", `/api/campaigns/${slug}/donations`, {
      amount: 25,
      donorName: "Test Donor",
      email: `donor-${ts}@forkup.test`,
      anonymous: false,
    });
    if (donate.status === 201 || donate.status === 200) {
      pass("2", "Virtual donation", `$${donate.json?.amount ?? 25}`);
    } else fail("2", "Virtual donation", JSON.stringify(donate.json));

    const dash2 = await api("GET", `/api/manage/campaigns/${slug}`);
    const count = dash2.json?.virtualDonations?.count ?? 0;
    if (count > 0) pass("2", "Donation reflected in dashboard", `count ${count}`);
    else fail("2", "Donation reflected in dashboard");
  } catch (e) {
    fail("2", "Phase 2 exception", String(e.message));
  }

  // --- Phase 3 ---
  console.log("\nPhase 3 — Auth, participants, receipts, settlement");
  try {
    const reg = await api("POST", "/api/auth/register", {
      email: testEmail,
      password: "TestPass123!",
      fullName: "Phase Test User",
    });
    if (reg.status === 201 && reg.json?.token) {
      token = reg.json.token;
      pass("3", "Auth register");
    } else fail("3", "Auth register", JSON.stringify(reg.json));

    const me = await api("GET", "/api/auth/me", null, token);
    if (me.status === 200 && me.json?.email === testEmail) pass("3", "Auth session /me");
    else fail("3", "Auth session /me");

    if (nonprofitId && token) {
      const link = await api(
        "POST",
        "/api/auth/link-organization",
        { organizationType: "nonprofit", organizationId: nonprofitId, role: "admin" },
        token,
      );
      if (link.status === 200 || link.status === 201) pass("3", "Link organization");
      else fail("3", "Link organization", JSON.stringify(link.json));
    }

    const slug = newSlug || SEED_SLUG;
    const amb = await api("POST", `/api/manage/campaigns/${slug}/participants`, {
      participantType: "ambassador",
      name: "Test Ambassador",
      email: `ambassador-${ts}@forkup.test`,
    });
    if (amb.status === 201 && amb.json?.id) {
      participantId = amb.json.id;
      pass("3", "Add ambassador", amb.json.trackingCode ?? "");
    } else fail("3", "Add ambassador", JSON.stringify(amb.json));

    const parts = await api("GET", `/api/manage/campaigns/${slug}/participants`);
    if (parts.status === 200 && Array.isArray(parts.json) && parts.json.length > 0) {
      pass("3", "List participants", `${parts.json.length} total`);
    } else fail("3", "List participants");

    const detail = await api("GET", `/api/campaigns/${SEED_SLUG}`);
    const pl = detail.json?.participatingLocations?.[0];
    const method = detail.json?.methods?.find((m) => m.methodType === "dine_and_donate");

    if (pl && method) {
      const tinyPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const upload = await api("POST", `/api/campaigns/${SEED_SLUG}/receipts`, {
        firstName: "Receipt",
        email: `receipt-${ts}@forkup.test`,
        businessId: pl.businessId,
        locationId: pl.locationId,
        methodId: method.id,
        imageBase64: tinyPng,
        imageMimeType: "image/png",
        claimedSubtotal: 42.5,
      });
      if (upload.status === 201 && upload.json?.id) {
        receiptId = upload.json.id;
        pass("3", "Upload receipt", `id ${receiptId}`);
      } else fail("3", "Upload receipt", JSON.stringify(upload.json));
    } else {
      fail("3", "Upload receipt", "no seeded participating location");
    }

    const receipts = await api("GET", `/api/campaigns/${SEED_SLUG}/receipts`);
    if (receipts.status === 200 && Array.isArray(receipts.json)) {
      pass("3", "List receipts", `${receipts.json.length} receipts`);
      if (!receiptId && receipts.json[0]?.id) receiptId = receipts.json[0].id;
    } else fail("3", "List receipts");

    if (receiptId) {
      const review = await api("POST", `/api/receipts/${receiptId}/review`, {
        action: "approve",
        eligibleSubtotal: 40,
      });
      if (review.status === 200) pass("3", "Approve receipt");
      else fail("3", "Approve receipt", JSON.stringify(review.json));
    }

    const settlement = await api("GET", `/api/manage/campaigns/${SEED_SLUG}/settlement`);
    if (settlement.status === 200 && settlement.json != null) {
      pass("3", "Settlement report", settlement.json.campaignName ?? "ok");
    } else fail("3", "Settlement report");
  } catch (e) {
    fail("3", "Phase 3 exception", String(e.message));
  }

  // --- Phase 4 ---
  console.log("\nPhase 4 — Entry flows");
  try {
    const bizClaim = await api("POST", "/api/profiles/businesses/claim", {
      businessName: `Phase Test Biz ${ts}`,
      contactName: "Biz Owner",
      contactEmail: `biz-${ts}@forkup.test`,
      businessType: "Restaurant",
      locationName: "Main",
      city: "West Chester",
      state: "PA",
      supportsDineAndDonate: true,
    });
    if ((bizClaim.status === 200 || bizClaim.status === 201) && bizClaim.json?.business?.id) {
      businessId = bizClaim.json.business.id;
      locationId = bizClaim.json.business.locations?.[0]?.id ?? locationId;
      pass("4", "Business claim", `id ${businessId}`);
    } else fail("4", "Business claim", JSON.stringify(bizClaim.json));

    const nonprofits = await api("GET", "/api/profiles/nonprofits");
    const targetNp = nonprofits.json?.find((n) => n.slug === "west-chester-education-foundation");
    const npId = targetNp?.id ?? nonprofitId;

    if (businessId && locationId && npId) {
      const npInv = await api("POST", "/api/business/nonprofit-invites", {
        businessId,
        locationId,
        nonprofitId: npId,
        methodType: "dine_and_donate",
        givebackPercentage: 12,
        message: "Join our test campaign",
      });
      if (npInv.status === 201 && npInv.json?.token) {
        nonprofitInviteToken = npInv.json.token;
        pass("4", "Business → nonprofit invite", npInv.json.acceptUrl ?? "token ok");
      } else fail("4", "Business → nonprofit invite", JSON.stringify(npInv.json));

      if (nonprofitInviteToken) {
        const npGet = await api("GET", `/api/business/nonprofit-invites/${nonprofitInviteToken}`);
        if (npGet.status === 200) pass("4", "Load nonprofit invite");
        else fail("4", "Load nonprofit invite");

        const npAccept = await api("POST", `/api/business/nonprofit-invites/${nonprofitInviteToken}/accept`, {
          contactName: "NP Contact",
          contactEmail: testEmail,
        });
        if (npAccept.status === 200) pass("4", "Nonprofit accepts invite");
        else fail("4", "Nonprofit accepts invite", JSON.stringify(npAccept.json));
      }
    } else {
      fail("4", "Business → nonprofit invite", "missing ids");
    }

    if (npId) {
      const pending = await api("GET", `/api/manage/nonprofits/${npId}/pending-invites`);
      if (pending.status === 200 && Array.isArray(pending.json)) {
        pass("4", "Pending invites list", `${pending.json.length} items`);
      } else fail("4", "Pending invites list");
    }
  } catch (e) {
    fail("4", "Phase 4 exception", String(e.message));
  }

  // --- Phase 5 ---
  console.log("\nPhase 5 — Success Engine");
  try {
    const slug = newSlug || SEED_SLUG;
    const se = await api("GET", `/api/manage/campaigns/${slug}/success-engine`);
    if (se.status === 200 && Array.isArray(se.json) && se.json.length > 0) {
      successActionId = se.json.find((a) => a.status !== "completed")?.id ?? se.json[0].id;
      pass("5", "Success Engine actions", `${se.json.length} actions`);
    } else fail("5", "Success Engine actions", JSON.stringify(se.json));

    if (successActionId) {
      const patch = await api("PATCH", `/api/manage/success-engine/${successActionId}`, {
        status: "completed",
      });
      if (patch.status === 200) pass("5", "Mark action complete");
      else fail("5", "Mark action complete", JSON.stringify(patch.json));
    }
  } catch (e) {
    fail("5", "Phase 5 exception", String(e.message));
  }

  // --- Phase 6 ---
  console.log("\nPhase 6 — Public discovery & pages");
  try {
    const list = await api("GET", "/api/campaigns");
    if (list.status === 200 && Array.isArray(list.json) && list.json.length >= 1) {
      pass("6", "Campaign list API", `${list.json.length} campaigns`);
    } else fail("6", "Campaign list API");

    const detail = await api("GET", `/api/campaigns/${SEED_SLUG}`);
    if (
      detail.status === 200 &&
      detail.json?.slug === SEED_SLUG &&
      Array.isArray(detail.json.participatingLocations)
    ) {
      pass("6", "Campaign detail API", `${detail.json.participatingLocations.length} locations`);
    } else fail("6", "Campaign detail API");

    const webPages = [
      ["/", "Landing"],
      ["/?step=nonprofit-claim", "Nonprofit claim"],
      ["/?step=start", "Builder start"],
      ["/?step=choose-account-type", "Account type"],
      ["/?step=campaign-directory", "Campaign directory"],
      [`/campaign/${SEED_SLUG}/`, "Public campaign page"],
    ];
    for (const [path, label] of webPages) {
      const w = await webGet(path);
      if (w.status === 200) pass("6", `Web: ${label}`);
      else fail("6", `Web: ${label}`, `HTTP ${w.status}`);
    }
  } catch (e) {
    fail("6", "Phase 6 exception", String(e.message));
  }

  // --- Summary ---
  console.log("\n=== Summary ===\n");
  const byPhase = {};
  for (const r of results) {
    if (!byPhase[r.phase]) byPhase[r.phase] = { pass: 0, fail: 0 };
    if (r.ok) byPhase[r.phase].pass++;
    else byPhase[r.phase].fail++;
  }
  for (const p of Object.keys(byPhase).sort()) {
    const { pass: p1, fail: f1 } = byPhase[p];
    console.log(`Phase ${p}: ${p1} passed, ${f1} failed`);
  }
  const failed = results.filter((r) => !r.ok);
  const totalPass = results.filter((r) => r.ok).length;
  console.log(`\nTotal: ${totalPass}/${results.length} passed`);
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) {
      console.log(`  Phase ${f.phase} — ${f.name}: ${f.detail}`);
    }
    process.exit(1);
  }
  console.log("\nAll phase tests passed.\n");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
