CREATE TABLE "auth_ip_throttle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_ip_throttle_ip_created_at_idx" ON "auth_ip_throttle" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "auth_ip_throttle_created_at_idx" ON "auth_ip_throttle" USING btree ("created_at");