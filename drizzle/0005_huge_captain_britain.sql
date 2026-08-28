ALTER TABLE `runs` ADD `prompt_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `completion_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `cached_input_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `cache_write_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `reasoning_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `model_turns` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `tool_calls` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `tool_duration_ms` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `first_token_ms` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `cost_usd` real;--> statement-breakpoint
ALTER TABLE `runs` ADD `harness` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `harness_version` text;