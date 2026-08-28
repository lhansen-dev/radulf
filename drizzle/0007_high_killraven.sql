PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Null out orphaned refs before adding FKs below: drizzle's migrator runs
-- these statements inside one transaction, where PRAGMA foreign_keys is a
-- no-op (SQLite forbids toggling it mid-transaction), so the connection's
-- foreign_keys=ON (set in src/db/index.ts before migrate() runs) is still
-- in effect for the INSERT further down — any events row referencing an
-- already-deleted card/run would otherwise fail the new FK constraint.
UPDATE `events` SET `card_id` = NULL WHERE `card_id` IS NOT NULL AND `card_id` NOT IN (SELECT `id` FROM `cards`);--> statement-breakpoint
UPDATE `events` SET `run_id` = NULL WHERE `run_id` IS NOT NULL AND `run_id` NOT IN (SELECT `id` FROM `runs`);--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` text,
	`run_id` text,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_events`("id", "card_id", "run_id", "type", "payload", "created_at") SELECT "id", "card_id", "run_id", "type", "payload", "created_at" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `events_card_id_idx` ON `events` (`card_id`,`id`);