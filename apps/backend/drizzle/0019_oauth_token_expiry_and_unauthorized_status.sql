ALTER TYPE "public"."mcp_server_error_status" ADD VALUE 'UNAUTHORIZED' BEFORE 'ERROR';--> statement-breakpoint
ALTER TABLE "oauth_sessions" ADD COLUMN "tokens_issued_at" timestamp with time zone;--> statement-breakpoint
-- Seed the new column for sessions that already hold tokens. `updated_at` is
-- an upper bound on when those tokens were issued: it also moves for
-- code_verifier and expected_state writes, so it can only ever make a token
-- look younger than it is, never older. The consequence is a possible missed
-- proactive refresh on the first cycle after upgrading, which refresh-on-401
-- still covers. The value becomes exact the first time the tokens are written.
UPDATE "oauth_sessions" SET "tokens_issued_at" = "updated_at" WHERE "tokens" IS NOT NULL;
