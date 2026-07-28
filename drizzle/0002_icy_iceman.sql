ALTER TABLE `cards` DROP COLUMN `summarizer_model`;--> statement-breakpoint
UPDATE `cards` SET `status` = 'needs_attention' WHERE `status` = 'summarizing';
