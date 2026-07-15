import { Router } from "express";

export const improveStoryRouter = Router();

improveStoryRouter.post("/improve-story", async (req, res) => {
  try {
    const story = typeof req.body?.story === "string" ? req.body.story.trim() : "";
    if (!story || story.length > 5000) {
      res.status(400).json({ error: "Invalid story text." });
      return;
    }
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "Missing LOVABLE_API_KEY" });
      return;
    }

    const system = [
      "You are an expert storytelling editor for nonprofit fundraising campaigns.",
      "Your job is not simply to rewrite text. Strengthen the story so readers understand why the cause matters, what their support accomplishes, and why they should get involved.",
      "When improving, prioritize in this order:",
      "1. Emotional connection",
      "2. Clarity",
      "3. Impact",
      "4. Community involvement",
      "5. Supporter motivation",
      "Help the nonprofit move beyond describing what they do, and instead explain why people should care and how their participation makes a difference.",
      "Rules:",
      "- Correct spelling and grammar.",
      "- Improve sentence structure, readability, and flow.",
      "- Remove repetition and repeated phrases.",
      "- Preserve the user's original meaning and specific details.",
      "- Add genuine emotion and a clear sense of impact, but stay truthful to what was shared.",
      "- Do NOT add generic fundraising clichés or boilerplate calls to action.",
      "- Do NOT simply append extra paragraphs of generic language.",
      "- Keep it roughly the same length as the original.",
      "Return ONLY the improved story text, with no preamble, quotes, or commentary.",
    ].join("\n");

    const upstream = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": apiKey,
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: system },
          { role: "user", content: story },
        ],
      }),
    });

    if (upstream.status === 429) {
      res.status(429).json({ error: "Rate limited. Please try again in a moment." });
      return;
    }
    if (upstream.status === 402) {
      res.status(402).json({ error: "AI credits exhausted. Please add credits to continue." });
      return;
    }
    if (!upstream.ok) {
      res.status(502).json({ error: "Could not improve the story. Please try again." });
      return;
    }

    const json = (await upstream.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const improved = json.choices?.[0]?.message?.content?.trim();
    if (!improved) {
      res.status(502).json({ error: "Could not improve the story. Please try again." });
      return;
    }

    res.json({ improved });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not improve the story.";
    res.status(400).json({ error: message });
  }
});
