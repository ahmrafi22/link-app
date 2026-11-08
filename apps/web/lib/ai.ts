// Phase ④ — provider-agnostic AI client.
// Primary: Gemini native (generativelanguage.googleapis.com) — matches the
// plan's free-tier choice and its 768-dim embedding contract.
// Alternative: any OpenAI-compatible endpoint (OpenAI, Groq, OpenRouter,
// self-hosted) via OPENAI_API_KEY + OPENAI_BASE_URL.
// GEMINI_API_KEY wins when both are set. NEVER mix embedding models — the
// items.embedding column is vector(768) and switching models invalidates
// every stored vector (plan rule: a switch = full re-embed).

const GEMINI_LLM = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
const GEMINI_EMBED = process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001";
const EMBED_DIMS = 768;
const TIMEOUT_MS = 30_000;

const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_BASE = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const OPENAI_EMBED_MODEL = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

export function aiConfigured(): boolean {
  return Boolean(GEMINI_KEY || OPENAI_KEY);
}

export function aiProvider(): "gemini" | "openai" | null {
  if (GEMINI_KEY) return "gemini";
  if (OPENAI_KEY) return "openai";
  return null;
}

function extractJson(raw: string): Record<string, unknown> | null {
  // models occasionally wrap JSON in fences despite response_format
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/** One LLM call, JSON-mode, strict. Returns parsed object or null. */
export async function aiJson(
  system: string,
  user: string
): Promise<Record<string, unknown> | null> {
  try {
    if (GEMINI_KEY) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_LLM}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ parts: [{ text: user }] }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.2,
            },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }
      );
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
      return typeof text === "string" ? extractJson(text) : null;
    }

    if (OPENAI_KEY) {
      const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      const text = body?.choices?.[0]?.message?.content;
      return typeof text === "string" ? extractJson(text) : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 768-dim embedding for the pipeline. Null when the provider can't deliver. */
export async function aiEmbed(text: string): Promise<number[] | null> {
  const trimmed = text.slice(0, 6000);
  try {
    if (GEMINI_KEY) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED}:embedContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            content: { parts: [{ text: trimmed }] },
            taskType: "RETRIEVAL_DOCUMENT",
            outputDimensionality: EMBED_DIMS,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }
      );
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      const values = body?.embedding?.values;
      return Array.isArray(values) && values.length === EMBED_DIMS ? values : null;
    }

    if (OPENAI_KEY) {
      const call = async (withDims: boolean) =>
        fetch(`${OPENAI_BASE}/embeddings`, {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(
            withDims
              ? { model: OPENAI_EMBED_MODEL, input: trimmed, dimensions: EMBED_DIMS }
              : { model: OPENAI_EMBED_MODEL, input: trimmed }
          ),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      let res = await call(true);
      if (res.status === 400) res = await call(false); // provider without dims param
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      const values = body?.data?.[0]?.embedding;
      if (!Array.isArray(values)) return null;
      // Matryoshka-style truncation is valid for OpenAI-family embeddings;
      // anything shorter than the column would fail the insert → null
      if (values.length === EMBED_DIMS) return values;
      if (values.length > EMBED_DIMS) return values.slice(0, EMBED_DIMS);
      return null;
    }
    return null;
  } catch {
    return null;
  }
}
