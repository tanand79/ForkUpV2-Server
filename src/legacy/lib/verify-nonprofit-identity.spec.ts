import { findKnownOrganizationByName } from "./known-organization-profiles";
import { attributedContact, discoverNonprofitWebsite, publicUrl } from "./nonprofit-web-research";
import {
  decideWebsiteIdentity,
  evidenceMatchesOrganization,
  filterByOrgIdentityMatch,
  isUnsafeFetchUrl,
  mergeKeepingTrustedIrs,
  safeRedirectTarget,
  scoreOrgNameMatch,
  socialProfileMatchesOrg,
  type PageIdentitySignals,
} from "./verify-nonprofit-identity";

function signals(partial: Partial<PageIdentitySignals>): PageIdentitySignals {
  return {
    title: "",
    description: "",
    siteName: "",
    textSample: "",
    ...partial,
  };
}

describe("nonprofit identity", () => {
  it("does not verify Headstrong as Head To Head", () => {
    expect(scoreOrgNameMatch("Head To Head", "Headstrong").tier).toBe("reject");
    expect(scoreOrgNameMatch("Head To Head", "Headstrong Foundation").tier).toBe("reject");
    expect(scoreOrgNameMatch("Head To Head", "Head to Toe").tier).toBe("reject");
    expect(findKnownOrganizationByName("Head To Head")).toBeNull();

    const decision = decideWebsiteIdentity({
      organizationName: "Head To Head",
      website: "https://headstrong.org/",
      signals: signals({
        title: "Headstrong Foundation",
        siteName: "Headstrong",
        textSample: "We support families. The word head appears many times. head head head.",
      }),
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("identity_reject");

    const kept = filterByOrgIdentityMatch("Head To Head", [
      { organizationName: "Headstrong Foundation", ein: "11-1111111" },
      { organizationName: "Head To Head", ein: "22-2222222" },
    ]);
    expect(kept.map((row) => row.organizationName)).toEqual(["Head To Head"]);
  });

  it("verifies an exact organization and its official website", () => {
    expect(scoreOrgNameMatch("Head To Head", "Head To Head, Inc.").tier).toBe("exact");
    const decision = decideWebsiteIdentity({
      organizationName: "Head To Head",
      website: "https://headtohead.org/",
      signals: signals({
        title: "Head To Head | Home",
        siteName: "Head To Head",
        textSample: "Unrelated directory text about another charity.",
      }),
    });
    expect(decision.ok).toBe(true);
    expect(decision.confidence).toBe("high");
    const generic = decideWebsiteIdentity({
      organizationName: "Head To Head",
      website: "https://example.org/",
      signals: signals({ title: "Home", siteName: "Welcome" }),
    });
    expect(generic.ok).toBe(false);
    expect(generic.reason).toBe("identity_inconclusive");
    expect(
      evidenceMatchesOrganization(
        "Head To Head",
        "Head To Head official website",
        "https://headtohead.org/",
      ),
    ).toBe(true);
  });

  it("returns a verified social profile and does not invent a website", () => {
    expect(
      socialProfileMatchesOrg("Head To Head", "https://www.instagram.com/headtohead/"),
    ).toBe(true);
    expect(
      evidenceMatchesOrganization(
        "Head To Head",
        "Headstrong Foundation",
        "https://headstrong.org/",
      ),
    ).toBe(false);

    const merged = mergeKeepingTrustedIrs(
      {
        organizationName: "Head To Head",
        ein: "22-2222222",
        website: null,
        contactEmail: null,
        contactPhone: null,
      },
      {
        organizationName: "Head To Head",
        website: null,
        identityTier: "exact",
      },
    );
    expect(merged.website).toBeNull();
  });

  it("keeps same-name organizations separate", () => {
    const kept = filterByOrgIdentityMatch("Hope Center", [
      { organizationName: "Hope Center", ein: "11-1111111", city: "Austin" },
      { organizationName: "Hope Center", ein: "33-3333333", city: "Denver" },
      { organizationName: "Hope Center International", ein: "44-4444444", city: "Austin" },
    ]);
    const exact = kept.filter((row) => row.identityMatch === "exact");
    expect(exact).toHaveLength(2);
    expect(exact.map((row) => row.ein)).toEqual(["11-1111111", "33-3333333"]);
  });

  it("leaves missing phone and email empty", () => {
    const contact = attributedContact(
      [{ url: "https://headtohead.org/contact", text: "Visit our office. No phone listed." }],
      "https://headtohead.org/",
      null,
      null,
    );
    expect(contact.email).toBeNull();
    expect(contact.phone).toBeNull();
  });

  it("does not let conflicting data overwrite IRS identity", () => {
    const irs = {
      organizationName: "Head To Head",
      ein: "22-2222222",
      website: null,
      contactEmail: null,
      contactPhone: "215-555-0100",
    };
    const merged = mergeKeepingTrustedIrs(irs, {
      organizationName: "Headstrong Foundation",
      ein: "99-9999999",
      website: "https://headstrong.org/",
      contactEmail: "info@headstrong.org",
      contactPhone: "610-555-0199",
      identityTier: "reject",
    });
    expect(merged).toEqual(irs);

    const einConflict = mergeKeepingTrustedIrs(irs, {
      organizationName: "Head To Head",
      ein: "99-9999999",
      website: "https://other.example/",
      contactPhone: "610-555-0199",
      identityTier: "exact",
    });
    expect(einConflict.ein).toBe("22-2222222");
    expect(einConflict.organizationName).toBe("Head To Head");
    expect(einConflict.website).toBeNull();
    expect(einConflict.contactPhone).toBe("215-555-0100");
  });

  it("keeps the search result empty when the search provider fails", async () => {
    const previous = {
      tavily: process.env.TAVILY_API_KEY,
      access: process.env.AWS_ACCESS_KEY_ID,
      secret: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION,
    };
    process.env.TAVILY_API_KEY = "test-key";
    process.env.AWS_ACCESS_KEY_ID = "test-access";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
    process.env.AWS_REGION = "us-east-1";
    const spy = jest.spyOn(global, "fetch").mockRejectedValue(new Error("timeout"));
    try {
      const result = await discoverNonprofitWebsite({ organizationName: "Head To Head" });
      expect(result.website).toBeNull();
      expect(result.status).not.toBe("found");
    } finally {
      spy.mockRestore();
      process.env.TAVILY_API_KEY = previous.tavily;
      process.env.AWS_ACCESS_KEY_ID = previous.access;
      process.env.AWS_SECRET_ACCESS_KEY = previous.secret;
      process.env.AWS_REGION = previous.region;
    }
  });

  it("rejects internal network URLs and unsafe redirects", () => {
    expect(isUnsafeFetchUrl("http://127.0.0.1/")).toBe(true);
    expect(isUnsafeFetchUrl("http://10.1.1.1/")).toBe(true);
    expect(isUnsafeFetchUrl("http://192.168.0.5/")).toBe(true);
    expect(isUnsafeFetchUrl("http://169.254.169.254/latest/meta-data")).toBe(true);
    expect(isUnsafeFetchUrl("http://localhost/admin")).toBe(true);
    expect(isUnsafeFetchUrl("https://metadata.google.internal/")).toBe(true);
    expect(publicUrl("https://169.254.169.254/")).toBeNull();
    expect(publicUrl("https://localhost/secret")).toBeNull();
    expect(safeRedirectTarget("https://headtohead.org/", "http://127.0.0.1/")).toBeNull();
    expect(safeRedirectTarget("https://headtohead.org/", "http://169.254.169.254/")).toBeNull();
    expect(safeRedirectTarget("https://headtohead.org/a", "https://headtohead.org/about")).toBe(
      "https://headtohead.org/about",
    );
  });

  it("does not attach a social profile for a similar organization", () => {
    expect(
      socialProfileMatchesOrg(
        "Head To Head",
        "https://www.facebook.com/headstrong",
        "Headstrong Foundation",
      ),
    ).toBe(false);
    expect(
      socialProfileMatchesOrg("Head To Head", "https://www.facebook.com/headtohead", "Head To Head"),
    ).toBe(true);
  });

  it("keeps the source URL for contact details found on the official site", () => {
    const contact = attributedContact(
      [
        {
          url: "https://directory.example/head-to-head",
          text: "Phone (999) 555-0100 Email other@directory.example",
        },
        {
          url: "https://headtohead.org/contact",
          text: "Email hello@headtohead.org Phone (215) 555-0148",
        },
      ],
      "https://headtohead.org/",
      "hello@headtohead.org",
      "(215) 555-0148",
    );
    expect(contact.email).toBe("hello@headtohead.org");
    expect(contact.emailSource).toBe("https://headtohead.org/contact");
    expect(contact.phone).toBe("(215) 555-0148");
    expect(contact.phoneSource).toBe("https://headtohead.org/contact");

    const fromDirectory = attributedContact(
      [
        {
          url: "https://directory.example/head-to-head",
          text: "Email other@directory.example",
        },
      ],
      "https://headtohead.org/",
      "other@directory.example",
      null,
    );
    expect(fromDirectory.email).toBeNull();
  });
});
