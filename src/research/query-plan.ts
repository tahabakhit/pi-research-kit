export type QueryPlanWorkflow = "compare" | "discover";

export interface QueryPlanBudget {
  maxQueries?: number;
  limit?: number;
  maxFetch?: number;
}

export interface HostQueryPlan {
  version: 1;
  workflow: QueryPlanWorkflow;
  /** Explicit search strings are host supplied; the workflow never asks a model to invent more. */
  queries?: readonly string[];
  entities?: readonly string[];
  question?: string;
  scope?: "domain" | "global";
  domain?: string;
  topic?: string;
  days?: number;
  date?: string;
  depth?: WorkflowDepth;
  budget?: QueryPlanBudget;
  limit?: number;
  maxFetch?: number;
}

export interface ValidatedQueryPlan extends HostQueryPlan {
  readonly queries: readonly string[];
  readonly budget: Required<QueryPlanBudget>;
}

export const QUERY_PLAN_LIMITS = {
  maxQueries: 8,
  maxEntities: 4,
  maxQueryLength: 500,
  maxDays: 365,
  maxLimit: 20,
  maxFetch: 10,
} as const;

const DEPTHS = new Set(["shallow", "standard", "deep"]);
const WORKFLOWS = new Set<QueryPlanWorkflow>(["compare", "discover"]);

function boundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`query plan ${name} must be a non-empty string.`);
  const result = value.trim();
  if (result.length > maxLength) throw new Error(`query plan ${name} exceeds the ${maxLength}-character bound.`);
  return result;
}

function boundedInteger(value: unknown, name: string, fallback: number, maximum: number, minimum = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`query plan ${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function boundedDate(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(new Date(value).getTime())) {
    throw new Error("query plan date must be a valid bounded ISO date string.");
  }
  return value;
}

function stringList(value: unknown, name: string, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) {
    throw new Error(`query plan ${name} must contain between 1 and ${maxItems} items.`);
  }
  return value.map((item, index) => boundedString(item, `${name}[${index}]`, maxLength));
}

/** Validate a host-authored plan once, before any network-capable operation. */
export function validateQueryPlan(value: unknown, expectedWorkflow?: QueryPlanWorkflow): ValidatedQueryPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("query plan must be an object.");
  const input = value as Record<string, unknown>;
  if (input.version !== 1) throw new Error("query plan version must be 1.");
  if (typeof input.workflow !== "string" || !WORKFLOWS.has(input.workflow as QueryPlanWorkflow)) throw new Error("query plan workflow must be compare or discover.");
  const workflow = input.workflow as QueryPlanWorkflow;
  if (expectedWorkflow && workflow !== expectedWorkflow) throw new Error(`query plan workflow must be ${expectedWorkflow}.`);

  const entities = stringList(input.entities, "entities", QUERY_PLAN_LIMITS.maxEntities, 200);
  const question = input.question === undefined ? undefined : boundedString(input.question, "question", QUERY_PLAN_LIMITS.maxQueryLength);
  const queries = stringList(input.queries, "queries", QUERY_PLAN_LIMITS.maxQueries, QUERY_PLAN_LIMITS.maxQueryLength) ?? [];
  if (workflow === "compare") {
    if (!entities || entities.length < 2) throw new Error("compare query plans require 2-4 entities.");
    if (!question && queries.length === 0) throw new Error("compare query plans require a question or explicit queries.");
    if (queries.length > 0 && queries.length !== entities.length) throw new Error("compare query plans require one explicit query per entity.");
  } else {
    if (!input.topic && queries.length === 0) throw new Error("discover query plans require a topic or explicit queries.");
    if (input.topic !== undefined) boundedString(input.topic, "topic", 300);
    const scope = input.scope === undefined ? "domain" : input.scope;
    if (scope !== "domain" && scope !== "global") throw new Error("discover query plan scope must be domain or global.");
    if (scope === "domain") boundedString(input.domain, "domain", 200);
    if (scope === "global" && input.domain !== undefined) throw new Error("global query plans must not include a domain.");
  }

  const nestedBudget = input.budget;
  if (nestedBudget !== undefined && (nestedBudget === null || typeof nestedBudget !== "object" || Array.isArray(nestedBudget))) throw new Error("query plan budget must be an object.");
  const budgetRecord = (nestedBudget ?? {}) as Record<string, unknown>;
  const budget: Required<QueryPlanBudget> = {
    maxQueries: boundedInteger(budgetRecord.maxQueries ?? input.maxQueries, "budget.maxQueries", QUERY_PLAN_LIMITS.maxQueries, QUERY_PLAN_LIMITS.maxQueries, 1),
    limit: boundedInteger(budgetRecord.limit ?? input.limit, "budget.limit", 10, QUERY_PLAN_LIMITS.maxLimit, 1),
    maxFetch: boundedInteger(budgetRecord.maxFetch ?? input.maxFetch, "budget.maxFetch", 5, QUERY_PLAN_LIMITS.maxFetch, 0),
  };
  if (queries.length > budget.maxQueries) throw new Error("query plan contains more queries than its maxQueries budget.");
  const days = boundedInteger(input.days, "days", 30, QUERY_PLAN_LIMITS.maxDays, 1);
  const date = boundedDate(input.date);
  const depth = input.depth === undefined ? undefined : input.depth;
  if (depth !== undefined && (typeof depth !== "string" || !DEPTHS.has(depth))) throw new Error("query plan depth must be shallow, standard, or deep.");
  const scope = input.scope === undefined ? undefined : input.scope;
  return {
    version: 1,
    workflow,
    queries,
    ...(entities ? { entities } : {}),
    ...(question ? { question } : {}),
    ...(scope === "domain" || scope === "global" ? { scope } : {}),
    ...(typeof input.domain === "string" ? { domain: input.domain.trim() } : {}),
    ...(typeof input.topic === "string" ? { topic: input.topic.trim() } : {}),
    ...(input.days === undefined ? {} : { days }),
    ...(date ? { date } : {}),
    ...(depth ? { depth: depth as WorkflowDepth } : {}),
    budget,
  };
}

export function planQueryList(plan: ValidatedQueryPlan, fallback: readonly string[]): readonly string[] {
  return plan.queries.length ? plan.queries : fallback;
}

// Kept local to avoid making workflow code depend on a second copy of the depth union.
export type WorkflowDepth = "shallow" | "standard" | "deep";
