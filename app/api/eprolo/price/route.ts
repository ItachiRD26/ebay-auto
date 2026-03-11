import { NextRequest, NextResponse } from "next/server";

// eProlo no tiene API pública — este endpoint genera la URL de búsqueda
// y en el futuro puede integrar scraping o su API si la habilitan
export async function POST(req: NextRequest) {
  try {
    const { title } = await req.json();
    if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });

    // Genera URL de búsqueda en eProlo para que el usuario la consulte manualmente
    const searchQuery = encodeURIComponent(title.slice(0, 80));
    const eproloUrl = `https://www.eprolo.com/search?keyword=${searchQuery}`;

    return NextResponse.json({ eproloUrl, message: "Manual lookup required" });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}