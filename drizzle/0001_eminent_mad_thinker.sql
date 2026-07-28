ALTER TABLE `repos` ADD `approved_install_scripts` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `sandboxed` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `disk_limit_mechanism` text;