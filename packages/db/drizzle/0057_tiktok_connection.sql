-- TikTok Shop T2 (docs/plans/tiktok-shop-integration.md §3.1, §3.2): the shop connection with
-- encrypted tokens, single-use OAuth states, sync cursors, the webhook inbox, and the
-- integrations.manage permission. New tables and reference rows only: nothing the previously
-- deployed release reads or writes changes, so rollback stays safe (expand-only).
CREATE TABLE "tiktok_oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "tiktok_oauth_states_hash_check" CHECK ("tiktok_oauth_states"."state_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tiktok_oauth_states_expiry_check" CHECK ("tiktok_oauth_states"."expires_at" > "tiktok_oauth_states"."created_at")
);
--> statement-breakpoint
CREATE TABLE "tiktok_shop_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" text NOT NULL,
	"shop_cipher" text NOT NULL,
	"shop_name" text,
	"region" text,
	"seller_type" text,
	"status" text NOT NULL,
	"access_token_ct" "bytea",
	"refresh_token_ct" "bytea",
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"token_key_version" smallint NOT NULL,
	"token_generation" integer DEFAULT 0 NOT NULL,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"connected_by_staff_user_id" uuid,
	"connected_at" timestamp with time zone NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"deauthorized_at" timestamp with time zone,
	"expiry_warning_at" timestamp with time zone,
	"last_webhook_at" timestamp with time zone,
	"last_poll_ok_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tiktok_shop_connections_shop_id_unique" UNIQUE("shop_id"),
	CONSTRAINT "tiktok_shop_connections_status_check" CHECK ("tiktok_shop_connections"."status" in ('active', 'reauth_required', 'deauthorized', 'disconnected')),
	CONSTRAINT "tiktok_shop_connections_tokens_paired_check" CHECK (("tiktok_shop_connections"."access_token_ct" is null) = ("tiktok_shop_connections"."refresh_token_ct" is null)),
	CONSTRAINT "tiktok_shop_connections_tokens_status_check" CHECK (("tiktok_shop_connections"."status" <> 'active' or "tiktok_shop_connections"."access_token_ct" is not null) and ("tiktok_shop_connections"."status" not in ('deauthorized', 'disconnected') or "tiktok_shop_connections"."access_token_ct" is null)),
	CONSTRAINT "tiktok_shop_connections_key_version_check" CHECK ("tiktok_shop_connections"."token_key_version" between 1 and 255),
	CONSTRAINT "tiktok_shop_connections_token_generation_check" CHECK ("tiktok_shop_connections"."token_generation" >= 0),
	CONSTRAINT "tiktok_shop_connections_last_error_code_check" CHECK ("tiktok_shop_connections"."last_error_code" is null or char_length("tiktok_shop_connections"."last_error_code") <= 64)
);
--> statement-breakpoint
CREATE TABLE "tiktok_sync_cursors" (
	"resource" text PRIMARY KEY NOT NULL,
	"window_end" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error_code" text,
	"backfill_from" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tiktok_sync_cursors_resource_check" CHECK ("tiktok_sync_cursors"."resource" in ('orders', 'returns', 'cancellations', 'statements', 'payments', 'unsettled')),
	CONSTRAINT "tiktok_sync_cursors_last_error_code_check" CHECK ("tiktok_sync_cursors"."last_error_code" is null or char_length("tiktok_sync_cursors"."last_error_code") <= 64)
);
--> statement-breakpoint
CREATE TABLE "tiktok_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tts_notification_id" text NOT NULL,
	"type" smallint NOT NULL,
	"shop_id" text,
	"tiktok_order_id" text,
	"timestamp_s" bigint,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error_code" text,
	CONSTRAINT "tiktok_webhook_events_tts_notification_id_unique" UNIQUE("tts_notification_id"),
	CONSTRAINT "tiktok_webhook_events_status_check" CHECK ("tiktok_webhook_events"."status" in ('pending', 'processed', 'ignored', 'failed')),
	CONSTRAINT "tiktok_webhook_events_attempts_check" CHECK ("tiktok_webhook_events"."attempts" between 0 and 10),
	CONSTRAINT "tiktok_webhook_events_payload_size_check" CHECK ("tiktok_webhook_events"."payload" is null or octet_length("tiktok_webhook_events"."payload"::text) <= 16384),
	CONSTRAINT "tiktok_webhook_events_last_error_code_check" CHECK ("tiktok_webhook_events"."last_error_code" is null or char_length("tiktok_webhook_events"."last_error_code") <= 64)
);
--> statement-breakpoint
ALTER TABLE "tiktok_oauth_states" ADD CONSTRAINT "tiktok_oauth_states_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tiktok_shop_connections" ADD CONSTRAINT "tiktok_shop_connections_connected_by_staff_user_id_staff_users_id_fk" FOREIGN KEY ("connected_by_staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tiktok_oauth_states_staff_user_id_idx" ON "tiktok_oauth_states" USING btree ("staff_user_id");--> statement-breakpoint
CREATE INDEX "tiktok_oauth_states_expires_at_idx" ON "tiktok_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tiktok_shop_connections_one_active" ON "tiktok_shop_connections" USING btree ("status") WHERE "tiktok_shop_connections"."status" = 'active';--> statement-breakpoint
CREATE INDEX "tiktok_shop_connections_connected_by_idx" ON "tiktok_shop_connections" USING btree ("connected_by_staff_user_id");--> statement-breakpoint
CREATE INDEX "tiktok_webhook_events_pending_idx" ON "tiktok_webhook_events" USING btree ("next_attempt_at") WHERE "tiktok_webhook_events"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "tiktok_webhook_events_tiktok_order_id_idx" ON "tiktok_webhook_events" USING btree ("tiktok_order_id");--> statement-breakpoint
CREATE INDEX "tiktok_webhook_events_received_at_idx" ON "tiktok_webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "tiktok_shop_connections" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "tiktok_sync_cursors" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint

-- Plan §3.1: the new permission key (PERMISSIONS in packages/db/src/rbac/permissions.ts), granted to
-- super_admin and owner (not in OWNER_EXCLUDED_PERMISSION_KEYS). Same idempotent pattern as 0049.
INSERT INTO "permissions" ("key", "description", "group") VALUES
  ('integrations.manage', 'Connect, reconnect and disconnect marketplace integrations (TikTok Shop)', 'settings')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r, "permissions" p
WHERE r."key" IN ('super_admin', 'owner') AND p."key" = 'integrations.manage'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
