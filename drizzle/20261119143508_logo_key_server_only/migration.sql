-- Edited by hand: logo_key is written only by the server upload path (service connection with
-- explicit owner and template filters). A teacher could otherwise point it at any object key
-- (IDOR through every reader of the column). The insert policy now requires it to be null; the
-- column-level UPDATE grant from 20261119102716 loses logo_key (the other columns keep theirs).
ALTER POLICY "school_templates_owner_insert" ON "school_templates" TO "authenticated" WITH CHECK ("school_templates"."owner_id" = auth.uid() and "school_templates"."logo_key" is null);--> statement-breakpoint
REVOKE UPDATE ("logo_key") ON "school_templates" FROM authenticated;
