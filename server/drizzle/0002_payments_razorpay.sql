CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payment_id" uuid,
	"outcome" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "currency" text DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider_order_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider_payment_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refund_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refund_status" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refund_amount_paise" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_event_uniq" ON "payment_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_customer_idem_uniq" ON "orders" USING btree ("customer_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_order_uniq" ON "payments" USING btree ("provider_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_payment_uniq" ON "payments" USING btree ("provider_payment_id");