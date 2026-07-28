CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'backlog' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`base_branch` text,
	`source` text DEFAULT 'user' NOT NULL,
	`max_iterations` integer,
	`review_plan_before_implementation` integer DEFAULT 0 NOT NULL,
	`timeout_minutes` integer,
	`planner_model` text,
	`loop_model` text,
	`evaluator_model` text,
	`summarizer_model` text,
	`summary` text,
	`started_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cards_status_position_idx` ON `cards` (`status`,`position`);--> statement-breakpoint
CREATE INDEX `cards_repo_status_position_idx` ON `cards` (`repo_id`,`status`,`position`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` text,
	`run_id` text,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_card_id_idx` ON `events` (`card_id`,`id`);--> statement-breakpoint
CREATE TABLE `iterations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`n` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`transcript_path` text NOT NULL,
	`summary` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`cached_input_tokens` integer,
	`cache_write_tokens` integer,
	`reasoning_tokens` integer,
	`model_turns` integer,
	`tool_calls` integer,
	`tool_duration_ms` integer,
	`first_token_ms` integer,
	`cost_usd` real,
	`actual_provider` text,
	`actual_model` text,
	`harness` text,
	`harness_version` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `iterations_run_n_idx` ON `iterations` (`run_id`,`n`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`version` integer NOT NULL,
	`plan_md` text NOT NULL,
	`prompt_md` text NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`feedback` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plans_card_version_idx` ON `plans` (`card_id`,`version`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_name_unique` ON `repos` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `repos_path_unique` ON `repos` (`path`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`decision` text NOT NULL,
	`feedback` text,
	`merge_commit` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_run_id_unique` ON `reviews` (`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`plan_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`worktree_path` text NOT NULL,
	`branch` text NOT NULL,
	`base_branch` text,
	`iterations_done` integer DEFAULT 0 NOT NULL,
	`exit_reason` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`provider` text,
	`model` text,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_card_started_idx` ON `runs` (`card_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
