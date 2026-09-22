ALTER TABLE `cards` ADD `scoping_authors_plan` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `plans` ADD `origin` text DEFAULT 'planner' NOT NULL;