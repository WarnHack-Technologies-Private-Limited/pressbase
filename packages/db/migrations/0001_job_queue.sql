CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(191) NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"backoff_seconds" integer DEFAULT 30 NOT NULL,
	"timeout_seconds" integer DEFAULT 300 NOT NULL,
	"singleton_key" text,
	"last_error" text,
	"locked_by" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "jobs_status_run_at_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_singleton_key" ON "jobs" USING btree ("singleton_key") WHERE status in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "jobs_cron_hook_idx" ON "jobs" USING btree ((data ->> 'hook'),"run_at") WHERE name = 'cron' and status = 'pending';