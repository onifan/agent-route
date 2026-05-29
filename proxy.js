import { NextResponse } from "next/server";

const LEGACY_PROVIDER_API_PREFIXES = ["/api/providers", "/api/provider-nodes", "/api/oauth"];
const LEGACY_PROVIDER_PAGE_PREFIX = "/dashboard/providers";

export function proxy(request) {
  const { pathname, origin } = request.nextUrl;
  if (LEGACY_PROVIDER_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.json(
      {
        error: {
          message: "Legacy provider and OAuth management has been removed. Use /agent-route#model-apis.",
          code: "legacy_provider_removed",
          type: "invalid_request_error"
        }
      },
      { status: 410 }
    );
  }
  if (pathname === LEGACY_PROVIDER_PAGE_PREFIX || pathname.startsWith(`${LEGACY_PROVIDER_PAGE_PREFIX}/`)) {
    return NextResponse.redirect(`${origin}/agent-route#model-apis`);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/providers/:path*", "/api/provider-nodes/:path*", "/api/oauth/:path*", "/dashboard/providers/:path*"]
};
