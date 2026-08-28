CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`run_id` text,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_path_unique` ON `worktrees` (`path`);--> statement-breakpoint
CREATE INDEX `worktrees_removed_at_idx` ON `worktrees` (`removed_at`);