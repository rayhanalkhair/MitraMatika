import { LoadingView } from "@/components/shell/LoadingView";

// Shown at once while a page of the signed-in area fetches its data (every segment below the
// shell group falls back to it), so a slow network never leaves the old page frozen without a cue.
export default function ShellLoading() {
  return <LoadingView />;
}
