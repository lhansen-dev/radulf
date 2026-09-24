CREATE TABLE `ref_writes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_path` text NOT NULL,
	`ref` text NOT NULL,
	`sha` text NOT NULL,
	`worker_id` text,
	`written_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ref_writes_repo_written_idx` ON `ref_writes` (`repo_path`,`written_at`);--> statement-breakpoint
CREATE TABLE `repo_leases` (
	`repo_path` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`acquired_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`card_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`from_status` text NOT NULL,
	`approved_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`worker_id` text,
	`ok` integer,
	`error` text,
	`created_at` text NOT NULL,
	`claimed_at` text,
	`ended_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_deliveries_status_idx` ON `review_deliveries` (`status`);