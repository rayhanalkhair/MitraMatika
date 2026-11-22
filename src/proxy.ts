import type { NextRequest } from "next/server";
import { protect } from "@/features/auth";

export async function proxy(request: NextRequest) {
  return protect(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|pdfjs/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
