/* Analyze and rank with Anthropic. */

const DEFAULT_MODEL = "claude-3-5-haiku-20241022";

async function callAnthropic(prompt, apiKey, proxyUrl) {
  if (!apiKey && !proxyUrl) return null;
  const payload = {
    model: DEFAULT_MODEL,
    max_tokens: 500,
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
    return data.content?.[0]?.text || "";
  } catch {
    return null;
  }
}

export async function analyzeItem({ title, body, note, apiKey, proxyUrl }) {
  const prompt = `You categorize items for a personal finite daily reading app called Edition.

Item:
Title: ${title || "(none)"}
Content: ${body || "(none)"}
User note: ${note || "(none)"}

Return ONLY valid JSON with these keys:
- type: one of "link", "article", "video", "doc", "thought", "note", "photo"
- category: short label like "work", "learning", "personal", "news", "inspiration", "reference"
- title: cleaned title, max 90 chars
- summary: one sentence on why it might matter, max 160 chars
- minutes: integer estimate of time to consume
- tags: array of 1-3 short tags

No markdown, no explanation.`;
  const text = await callAnthropic(prompt, apiKey, proxyUrl);
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

export async function rankItems({ active, kept, dropped, apiKey, proxyUrl }) {
  if (!active.length) return null;
  const keptLines = kept.slice(0, 8).map((i) => `- ${i.title} (${i.category || i.type})`).join("\n") || "(none yet)";
  const droppedLines = dropped.slice(0, 6).map((i) => `- ${i.title}`).join("\n") || "(none yet)";
  const activeLines = active.map((i) => `${i.id}: ${i.title} | ${i.summary || ""} | ${i.type}`).join("\n");

  const prompt = `You rank a personal feed for one person. Their past triage teaches you what they keep versus let go.

They kept or finished:
${keptLines}

They let go:
${droppedLines}

Active items to rank (id: title | summary | type):
${activeLines}

Return ONLY valid JSON: {"ranks": [{"id": "...", "score": 0-100, "why": "short reason"}]}
Higher score = more likely they want it in today's edition.
No markdown.`;

  const text = await callAnthropic(prompt, apiKey, proxyUrl);
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}
