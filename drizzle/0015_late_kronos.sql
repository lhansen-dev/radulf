CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`repo_id` text,
	`cron` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`last_fired_at` text,
	`last_result` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schedules_enabled_idx` ON `schedules` (`enabled`);