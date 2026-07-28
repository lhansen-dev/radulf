CREATE TABLE `improvement_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`feature_branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`focus_prompt` text,
	`planner_model` text,
	`loop_model` text,
	`evaluator_model` text,
	`planner_reasoning` text,
	`loop_reasoning` text,
	`evaluator_reasoning` text,
	`max_iterations` integer,
	`timeout_minutes` integer,
	`deadline_at` text NOT NULL,
	`current_card_id` text,
	`tasks_created` integer DEFAULT 0 NOT NULL,
	`tasks_succeeded` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `improvement_runs_repo_status_idx` ON `improvement_runs` (`repo_id`,`status`);