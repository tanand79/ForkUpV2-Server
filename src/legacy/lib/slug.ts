export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function uniqueCampaignSlug(
  baseName: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  const base = slugify(baseName) || "campaign";
  let slug = base;
  let counter = 1;
  while (await exists(slug)) {
    slug = `${base}-${counter}`;
    counter += 1;
  }
  return slug;
}
