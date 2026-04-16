import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { title } = await req.json() as { title: string };
    if (!title?.trim()) return NextResponse.json({ error: "title required" }, { status: 400 });

    const prompt = `Write a 2-3 sentence eBay product description for: "${title.slice(0, 100)}"

Rules:
- Professional tone, highlight key features and practical benefits
- NO brand names, NO medical claims, NO adult content, NO URLs
- Plain text only — no HTML, no bullet points
- Under 120 words
Return ONLY the description text, no quotes, no JSON.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) return NextResponse.json({ error: "Claude API error" }, { status: 500 });
    const data = await res.json() as { content: { type: string; text: string }[] };
    const description = data.content.find(b => b.type === "text")?.text?.trim() ?? "";
    return NextResponse.json({ description });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}