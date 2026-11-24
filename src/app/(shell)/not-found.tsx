import { NotFoundView } from "@/components/shell/NotFoundView";

// notFound() inside the signed-in area (a trashed or unknown question, material, assessment): the
// message sits in the app frame, so the menu stays.
export default function ShellNotFound() {
  return <NotFoundView framed />;
}
