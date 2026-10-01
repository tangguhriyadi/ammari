ALTER TABLE "customers" DROP CONSTRAINT "customers_phone_format_check";--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_format_check" CHECK ("customers"."phone" is null or "customers"."phone" ~ '^\+62[0-9]{8,13}$');