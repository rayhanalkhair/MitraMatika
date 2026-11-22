-- Edited by hand: moving to the trash, restoring and deleting for good run only on the service
-- connection with explicit owner filters (Task 10), so the authenticated role loses the grants it
-- no longer needs: DELETE on assessments and school_templates (a hard delete there would skip the
-- stored files and the deletion log), and UPDATE of deleted_at and purge_after on both (a row
-- trashed without purge_after is hidden from the trash and never purged). The other column-level
-- UPDATE grants from 20261119102716 stay.
REVOKE DELETE ON "assessments", "school_templates" FROM authenticated;--> statement-breakpoint
REVOKE UPDATE ("deleted_at", "purge_after") ON "assessments" FROM authenticated;--> statement-breakpoint
REVOKE UPDATE ("deleted_at", "purge_after") ON "school_templates" FROM authenticated;
