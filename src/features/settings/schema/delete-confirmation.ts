/**
 * Account deletion asks for the account's address, typed exactly: only surrounding spaces (from a
 * paste) are ignored, and the case must match too. Pure and free of server code, so the dialog
 * checks it before submitting and the Server Action checks it again against the session's address.
 */
export function emailConfirmationMatches(typed: string, accountEmail: string): boolean {
  const value = typed.trim();
  return value !== "" && value === accountEmail;
}
