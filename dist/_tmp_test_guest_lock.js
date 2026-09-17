"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const API = process.env.API_BASE || "https://forkup2.duckdns.org";
async function main() {
    const stamp = Date.now();
    const website = `https://lock-test-${stamp}.example.com`;
    const name = `Lock Test Biz ${stamp}`;
    const email1 = `owner-${stamp}@example.com`;
    const email2 = `other-${stamp}@example.com`;
    const r1 = await fetch(`${API}/api/profiles/businesses/claim-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            businessName: name,
            contactEmail: email1,
            website,
            joinDoorType: "restaurant",
            supportsDineAndDonate: true,
        }),
    });
    const j1 = await r1.json();
    console.log("first", r1.status, j1.action, "claimEmailSent=", j1.claimEmailSent);
    const r2 = await fetch(`${API}/api/profiles/businesses/claim-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            businessName: name,
            contactEmail: email2,
            website,
            joinDoorType: "restaurant",
            supportsDineAndDonate: true,
        }),
    });
    const j2 = await r2.json();
    console.log("second", r2.status, j2.action, j2.message?.slice?.(0, 80));
    const tok = "not-a-real-token";
    const r3 = await fetch(`${API}/api/guest-business-claim/${tok}`);
    console.log("claim route", r3.status, await r3.json());
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=_tmp_test_guest_lock.js.map