// ADR-062: the brief an owner (or the chat, on the owner's words) gives the planner. Client-safe and
// bounded, so a request can never carry an unbounded prompt. The budget is in the account currency's
// major unit as the owner typed it; the planner converts it with the platform's budget units.

import { z } from 'zod'

export const PLAN_GOALS = ['sales', 'leads', 'traffic'] as const
export type PlanGoal = (typeof PLAN_GOALS)[number]

export const planBriefSchema = z.object({
  goal: z.enum(PLAN_GOALS),
  product: z.string().trim().min(2).max(200),
  offer: z.string().trim().max(300).default(''),
  daily_budget: z.number().positive().max(1_000_000),
  audience_description: z.string().trim().max(300).default(''),
  countries: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).min(1).max(25),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  destination_url: z.string().trim().url().max(2048).nullable().default(null),
  /** Ask the model to propose the structure (when AI is on). Off always uses the template. */
  use_ai: z.boolean().default(true),
}).strict()

export type PlanBrief = z.infer<typeof planBriefSchema>
export type PlanBriefInput = z.input<typeof planBriefSchema>

export const PLAN_GOAL_LABEL: Record<PlanGoal, string> = { sales: 'Sales', leads: 'Leads', traffic: 'Traffic' }
