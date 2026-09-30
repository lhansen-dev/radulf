ALTER TABLE `cards` ADD `parent_card_id` text REFERENCES cards(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `cards` ADD `run_mode` text;--> statement-breakpoint
CREATE INDEX `cards_parent_card_id_idx` ON `cards` (`parent_card_id`);