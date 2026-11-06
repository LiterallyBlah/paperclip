ALTER TABLE "ai_connection_defaults" DROP CONSTRAINT "ai_connection_defaults_provider_check";--> statement-breakpoint
ALTER TABLE "ai_connection_defaults" ADD CONSTRAINT "ai_connection_defaults_provider_check" CHECK ("provider" in ('anthropic','openai','openrouter','xai','google','muse'));--> statement-breakpoint
ALTER TABLE "ai_provider_defaults" DROP CONSTRAINT "ai_provider_defaults_provider_check";--> statement-breakpoint
ALTER TABLE "ai_provider_defaults" ADD CONSTRAINT "ai_provider_defaults_provider_check" CHECK ("provider" in ('anthropic','openai','openrouter','xai','google','muse'));
