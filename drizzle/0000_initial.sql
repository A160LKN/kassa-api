CREATE TYPE "public"."event_status" AS ENUM('draft', 'published', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'paid', 'expired', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('organizer', 'customer');--> statement-breakpoint
CREATE TYPE "public"."seat_status" AS ENUM('free', 'held', 'sold');--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"organizer_id" integer NOT NULL,
	"title" varchar(120) NOT NULL,
	"venue" varchar(120) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"user_id" integer NOT NULL,
	"key" varchar(100) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"status_code" smallint,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"order_id" uuid NOT NULL,
	"seat_id" integer NOT NULL,
	"price" integer NOT NULL,
	CONSTRAINT "order_items_order_id_seat_id_pk" PRIMARY KEY("order_id","seat_id")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"event_id" integer NOT NULL,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"total" integer NOT NULL,
	"payment_id" varchar(64),
	"payment_error" varchar(200),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_payment_id_unique" UNIQUE("payment_id"),
	CONSTRAINT "orders_total_positive" CHECK ("orders"."total" > 0)
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"section" varchar(30) NOT NULL,
	"row" smallint NOT NULL,
	"number" smallint NOT NULL,
	"price" integer NOT NULL,
	"status" "seat_status" DEFAULT 'free' NOT NULL,
	"held_by" integer,
	"hold_expires_at" timestamp with time zone,
	"order_id" uuid,
	CONSTRAINT "seats_place" UNIQUE("event_id","section","row","number"),
	CONSTRAINT "seats_price_positive" CHECK ("seats"."price" > 0),
	CONSTRAINT "seats_hold_consistent" CHECK (("seats"."status" = 'held') = ("seats"."held_by" IS NOT NULL AND "seats"."hold_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(254) NOT NULL,
	"name" varchar(60) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"event_id" varchar(64) PRIMARY KEY NOT NULL,
	"type" varchar(40) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organizer_id_users_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_held_by_users_id_fk" FOREIGN KEY ("held_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_listing" ON "events" USING btree ("status","starts_at","id");--> statement-breakpoint
CREATE INDEX "orders_user" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "seats_event" ON "seats" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "seats_expiring" ON "seats" USING btree ("hold_expires_at") WHERE status = 'held';