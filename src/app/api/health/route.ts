import { NextResponse } from "next/server";
import { checkDbConnection } from "@/lib/db/client";
import { requireDatabaseUrl } from "@/lib/env";
import { logger } from "@/lib/logger";

// Region pinning next to the database (Singapore, D-005/P0-09) is
// NOT set here: Next.js 16 deprecated per-route `preferredRegion`, and
// Vercel only accepts 'auto'/'global'/'home' for it now, not a specific
// region code. Pin the deployment's actual region in the Vercel dashboard
// instead (Project Settings -> Functions -> Function Region), or via
// `vercel.json`'s `regions` field -- see
// docs/development/phase-0-remaining-work.md.
//
// `force-dynamic` is a no-op today (GET handlers aren't cached by default
// since Next 15), but it will need to be deleted if Cache Components is
// ever turned on for this project, since that mode removes `dynamic`.
export const dynamic = "force-dynamic";

export async function GET() {
  let ok: boolean;
  try {
    const result = await checkDbConnection(requireDatabaseUrl());
    ok = result.ok;
    if (result.ok) {
      logger.info(
        { module: "health", latencyMs: result.data.latencyMs },
        "Health check: OK",
      );
    } else {
      logger.error(
        { module: "health", error: result.error },
        "Health check: koneksi basis data gagal",
      );
    }
  } catch (error) {
    ok = false;
    logger.error(
      { module: "health", error: error instanceof Error ? error.message : error },
      "Health check: variabel lingkungan tidak valid",
    );
  }

  return NextResponse.json(
    {
      status: ok ? "ok" : "degraded",
      database: ok ? "connected" : "error",
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
