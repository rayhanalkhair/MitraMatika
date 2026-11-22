import { noticeClass } from "./styles";

export type Notice = { kind: "status" | "alert"; text: string } | null;

// No "use client": rendered only by the client components of the materials screens.
/**
 * Two live regions that never change role: a polite one for outcomes and an assertive one for
 * refusals. Screen readers announce a region reliably only when its role is stable.
 */
export function LiveNotice({ notice }: { notice: Notice }) {
  const status = notice?.kind === "status" ? notice.text : "";
  const alert = notice?.kind === "alert" ? notice.text : "";
  return (
    <>
      <p role="status" className={status ? noticeClass("status") : "sr-only"}>
        {status}
      </p>
      <p role="alert" className={alert ? noticeClass("alert") : "sr-only"}>
        {alert}
      </p>
    </>
  );
}
