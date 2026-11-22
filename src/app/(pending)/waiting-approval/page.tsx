import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { loadAccountSettings, requireSignedInUser } from "@/features/auth";
import { WaitingApproval } from "@/features/auth/ui/WaitingApproval";
import { DeleteAccountDialog } from "@/features/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("approval");
  return { title: t("title") };
}

// /waiting-approval: where every page sends a signed-in account whose email is not approved.
// Layouts do not re-run on client-side navigation, so the page checks too.
export default async function WaitingApprovalPage() {
  const user = await requireSignedInUser();
  if (user.status === "allowed") redirect("/home");
  const account = await loadAccountSettings(user.userId);
  return (
    <WaitingApproval
      email={user.email}
      deleteAccount={
        // Unknown (the read failed): ask for a password, the stricter rule.
        <DeleteAccountDialog
          email={user.email}
          hasPassword={account?.hasPassword ?? true}
        />
      }
    />
  );
}
