import { fetchOptionChain } from "@/lib/portfolio/symbolLookup";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const underlying = (params.get("underlying") ?? "").trim().toUpperCase();
  const expiry = (params.get("expiry") ?? "").trim();

  if (!underlying) return Response.json({ chain: null });

  const chain = await fetchOptionChain(underlying, expiry || undefined);

  // Null means the listing couldn't be read, not that the underlying has no
  // options. The caller shows a manual entry path rather than an error.
  return Response.json({ chain });
}
