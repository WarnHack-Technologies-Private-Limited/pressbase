CREATE TABLE "commentmeta" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"comment_id" bigint NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" jsonb
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"post_id" bigint NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"author_email" varchar(100) DEFAULT '' NOT NULL,
	"author_url" varchar(200) DEFAULT '' NOT NULL,
	"author_ip" varchar(100) DEFAULT '' NOT NULL,
	"date" timestamp with time zone DEFAULT now() NOT NULL,
	"content" text NOT NULL,
	"karma" integer DEFAULT 0 NOT NULL,
	"approved" varchar(20) DEFAULT '1' NOT NULL,
	"agent" varchar(255) DEFAULT '' NOT NULL,
	"type" varchar(20) DEFAULT 'comment' NOT NULL,
	"parent_id" bigint,
	"user_id" bigint
);
--> statement-breakpoint
CREATE TABLE "options" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(191) NOT NULL,
	"value" jsonb NOT NULL,
	"autoload" boolean DEFAULT true NOT NULL,
	CONSTRAINT "options_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "postmeta" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"post_id" bigint NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" jsonb
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"author_id" bigint,
	"date" timestamp with time zone DEFAULT now() NOT NULL,
	"modified" timestamp with time zone DEFAULT now() NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"status" varchar(20) DEFAULT 'publish' NOT NULL,
	"comment_status" varchar(20) DEFAULT 'open' NOT NULL,
	"ping_status" varchar(20) DEFAULT 'closed' NOT NULL,
	"password" varchar(255) DEFAULT '' NOT NULL,
	"slug" varchar(200) DEFAULT '' NOT NULL,
	"content_filtered" text DEFAULT '' NOT NULL,
	"parent_id" bigint,
	"guid" varchar(255) DEFAULT '' NOT NULL,
	"menu_order" integer DEFAULT 0 NOT NULL,
	"type" varchar(20) DEFAULT 'post' NOT NULL,
	"mime_type" varchar(100) DEFAULT '' NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" varchar(100) DEFAULT '' NOT NULL,
	"user_agent" varchar(255) DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "term_relationships" (
	"object_id" bigint NOT NULL,
	"term_taxonomy_id" bigint NOT NULL,
	"term_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "term_relationships_object_id_term_taxonomy_id_pk" PRIMARY KEY("object_id","term_taxonomy_id")
);
--> statement-breakpoint
CREATE TABLE "term_taxonomy" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"term_id" bigint NOT NULL,
	"taxonomy" varchar(32) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"parent_id" bigint,
	"count" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "termmeta" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"term_id" bigint NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" jsonb
);
--> statement-breakpoint
CREATE TABLE "terms" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"slug" varchar(200) NOT NULL,
	"term_group" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usermeta" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" jsonb
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"login" varchar(60) NOT NULL,
	"pass" varchar(255) NOT NULL,
	"nicename" varchar(50) NOT NULL,
	"email" varchar(100) NOT NULL,
	"url" varchar(100) DEFAULT '' NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activation_key" varchar(255) DEFAULT '' NOT NULL,
	"status" integer DEFAULT 0 NOT NULL,
	"display_name" varchar(250) DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commentmeta" ADD CONSTRAINT "commentmeta_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postmeta" ADD CONSTRAINT "postmeta_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_parent_id_posts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_relationships" ADD CONSTRAINT "term_relationships_term_taxonomy_id_term_taxonomy_id_fk" FOREIGN KEY ("term_taxonomy_id") REFERENCES "public"."term_taxonomy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_taxonomy" ADD CONSTRAINT "term_taxonomy_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_taxonomy" ADD CONSTRAINT "term_taxonomy_parent_id_term_taxonomy_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."term_taxonomy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "termmeta" ADD CONSTRAINT "termmeta_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usermeta" ADD CONSTRAINT "usermeta_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commentmeta_comment_key_idx" ON "commentmeta" USING btree ("comment_id","key");--> statement-breakpoint
CREATE INDEX "commentmeta_key_idx" ON "commentmeta" USING btree ("key");--> statement-breakpoint
CREATE INDEX "comments_post_idx" ON "comments" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "comments_approved_date_idx" ON "comments" USING btree ("approved","date");--> statement-breakpoint
CREATE INDEX "comments_date_idx" ON "comments" USING btree ("date");--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "comments_author_email_idx" ON "comments" USING btree ("author_email");--> statement-breakpoint
CREATE INDEX "postmeta_post_key_idx" ON "postmeta" USING btree ("post_id","key");--> statement-breakpoint
CREATE INDEX "postmeta_key_idx" ON "postmeta" USING btree ("key");--> statement-breakpoint
CREATE INDEX "posts_slug_idx" ON "posts" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "posts_type_status_date_idx" ON "posts" USING btree ("type","status","date","id");--> statement-breakpoint
CREATE INDEX "posts_parent_idx" ON "posts" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "posts_author_idx" ON "posts" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "posts_type_status_author_idx" ON "posts" USING btree ("type","status","author_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "term_relationships_tt_idx" ON "term_relationships" USING btree ("term_taxonomy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "term_taxonomy_term_taxonomy_key" ON "term_taxonomy" USING btree ("term_id","taxonomy");--> statement-breakpoint
CREATE INDEX "term_taxonomy_taxonomy_idx" ON "term_taxonomy" USING btree ("taxonomy");--> statement-breakpoint
CREATE INDEX "termmeta_term_key_idx" ON "termmeta" USING btree ("term_id","key");--> statement-breakpoint
CREATE INDEX "termmeta_key_idx" ON "termmeta" USING btree ("key");--> statement-breakpoint
CREATE INDEX "terms_slug_idx" ON "terms" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "terms_name_idx" ON "terms" USING btree ("name");--> statement-breakpoint
CREATE INDEX "usermeta_user_key_idx" ON "usermeta" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "usermeta_key_idx" ON "usermeta" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_login_key" ON "users" USING btree (lower("login"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_nicename_idx" ON "users" USING btree ("nicename");