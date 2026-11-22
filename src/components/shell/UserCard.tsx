import { SignOutButton } from "@/features/auth/ui/SignOutButton";
import { displayNameOf, initialsOf } from "./user-display";

export function UserCard({ name, email }: { name: string | null; email: string }) {
  return (
    <div className="flex flex-col gap-1 border-t border-sidebar-border pt-3">
      <div className="flex min-w-0 items-center gap-3 px-2.5 py-1.5">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent font-heading text-sm font-bold text-accent-foreground"
        >
          {initialsOf(name, email)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {displayNameOf(name, email)}
          </p>
          <p className="truncate text-xs text-muted-foreground">{email}</p>
        </div>
      </div>
      <SignOutButton />
    </div>
  );
}
