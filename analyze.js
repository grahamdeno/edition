/* Analyze a captured item with Anthropic. Returns structured fields or null. */

const DEFAULT_MODEL = "claude-3-5-haiku-20241022";

export async function analyzeItem({ title, body, note, apiKey, proxyUrl }) {
  if (!apiKey && !proxyUrl) return null;

  const prompt = `You categorize items for a personal finite daily reading app called Edition.

Item:
Title: ${title || "(none)"}
Content: ${body || "(none)"}
User note: ${note || "(none)"}

Return ONLY valid JSON with these keys:
- type: one of "link", "article", "video", "doc", "thought", "note"
- category: short label like "work", "learning", "personal", "news", "inspiration", "reference"
- title: cleaned title, max 90 chars
- summary: one sentence on why it might matter, max 160 chars
- minutes: integer estimate of time to consume
- tags: array of 1-3 short tags

No markdown, no explanation.`;

  const payload = {
    model: DEFAULT_MODEL,
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  };

  try {
    let res;
    if (proxyUrl) {
      res = await fetch(proxyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(payload),
      });
    }
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
