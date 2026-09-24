CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`pid` integer NOT NULL,
	`roles` text NOT NULL,
	`started_at` text NOT NULL,
	`heartbeat_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `cards` ADD `evaluation_pending` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `worker_id` text;