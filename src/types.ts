import { z } from 'zod/v4';

export const EventSchema = z.object({
  company_linkedin: z.string(),
  name: z.string(),
  date: z.string().nullable(),
  type: z.enum(['hosting', 'attending']),
  is_paid: z.boolean(),
  price: z.string().nullable(),
  source_url: z.string(),
  registration_url: z.string().nullable(),
  detected_at: z.string(),
  source: z.literal('linkedin'),
});

export type Event = z.infer<typeof EventSchema>;

export const LLMConfirmSchema = z.object({
  is_event: z.boolean(),
  name: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  type: z.enum(['hosting', 'attending']).nullable().optional(),
  is_paid: z.boolean().nullable().optional(),
  event_url: z.string().nullable().optional(),
});

export type LLMConfirmResult = z.infer<typeof LLMConfirmSchema>;

export const LLMSearchExtractSchema = z.object({
  best_url: z.string().nullable(),
  date: z.string().nullable(),
  location: z.string().nullable(),
  is_paid: z.boolean().nullable(),
  price: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
});

export type LLMSearchExtractResult = z.infer<typeof LLMSearchExtractSchema>;

export type Account = {
  name: string;
  domain: string;
  linkedin: string;
};

export type LinkedInPost = {
  content: string;
  linkedinUrl: string;
  author: { name: string; linkedinUrl: string };
  postedAt: { date: string };
  query: { targetUrl: string };
};
