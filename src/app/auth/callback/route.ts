import { NextResponse } from "next/server";
import {
  auditSignIn,
  forgetPendingEmailOn,
  getAuthPort,
  resolvePostSignInRedirect,
} from "@/features/auth";

// Google sign-in lands here after Better Auth has finished its own callback at
// /api/auth/callback/google (the GoogleButton passes this route as callbackURL and
// errorCallbackURL), and a verification link after /api/auth/verify-email (?method=email):
// make sure the profile exists, audit, redirect.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const method = url.searchParams.get("method") === "email" ? "email" : "google";
  const path = await resolvePostSignInRedirect(
    getAuthPort,
    url.searchParams,
    auditSignIn(method),
  );
  const response = NextResponse.redirect(new URL(path, url));
  response.headers.set("Cache-Control", "private, no-store");
  // Signed in through a verification link: the address kept for the resend is not needed now.
  if (method === "email" && path === "/home") forgetPendingEmailOn(response);
  return response;
}
