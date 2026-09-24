import { z } from "zod";

export const ActionType = z.enum([
  "click",
  "fill",
  "select",
  "navigate",
  "wait",
  "extract",
  "check",
]);
export const LocatorSpec = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("role"),
      role: z.enum([
        "button",
        "link",
        "textbox",
        "searchbox",
        "combobox",
        "heading",
        "region",
        "cell",
        "table",
        "row",
        "checkbox",
        "radio",
        "dialog",
        "tab",
      ]),
      name: z.string().min(1),
      exact: z.boolean().default(true),
    })
    .strict(),
  z.object({ kind: z.literal("label"), label: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("attribute"),
      attribute: z.enum(["name", "title", "href", "aria-label"]),
      value: z.string().min(1),
      tag: z.enum(["input", "a", "button", "select", "section", "textarea"]),
    })
    .strict(),
  z
    .object({ kind: z.literal("css"), selector: z.string().min(1).max(300) })
    .strict(),
]);
export const ParameterKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,59}$/)
  .refine((k) => !["constructor", "prototype", "__proto__"].includes(k));
export const OutputType = z.enum([
  "money",
  "text",
  "number",
  "boolean",
  "table",
]);
export const OutputDefinition = z
  .object({
    key: ParameterKey,
    type: OutputType,
    currency: z.literal("USD").optional(),
    description: z.string().min(1),
  })
  .strict();
export const Target = z
  .object({
    description: z.string().min(1),
    locators: z.array(LocatorSpec).min(1).max(6),
    within: z
      .object({
        role: z.enum(["region", "dialog", "row", "group", "navigation"]),
        name: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export const ValueRef = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("input"),
      key: ParameterKey,
    })
    .strict(),
  z
    .object({
      source: z.literal("secret"),
      key: z.enum(["RFCU_STAFF_USERNAME", "RFCU_STAFF_PASSWORD"]),
    })
    .strict(),
  z
    .object({ source: z.literal("literal"), value: z.string().max(500) })
    .strict(),
]);
export const Checkpoint = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("field_value"),
      target: Target,
      value: z
        .object({ source: z.literal("input"), key: ParameterKey })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal("visible"), target: Target }).strict(),
  z
    .object({ kind: z.literal("route"), path: z.string().startsWith("/") })
    .strict(),
  z.object({ kind: z.literal("authenticated") }).strict(),
  z.object({ kind: z.literal("member_resolved") }).strict(),
  z
    .object({
      kind: z.literal("output"),
      key: ParameterKey,
      type: OutputType,
    })
    .strict(),
]);
export const Step = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,60}$/),
    description: z.string().min(1).max(300),
    action: ActionType,
    target: Target.optional(),
    value: ValueRef.optional(),
    output: ParameterKey.optional(),
    outputType: OutputType.optional(),
    columns: z.array(z.string().min(1)).min(1).max(20).optional(),
    risk: z.enum(["read_only", "reversible", "sensitive", "irreversible"]),
    precondition: Checkpoint.optional(),
    expectedState: Checkpoint,
    retry: z
      .object({
        maxAttempts: z.number().int().min(1).max(3),
        safeToRepeat: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      ["click", "fill", "select", "extract", "check"].includes(s.action) &&
      !s.target
    )
      ctx.addIssue({ code: "custom", message: "Target required" });
    if (["fill", "select", "navigate", "check"].includes(s.action) && !s.value)
      ctx.addIssue({ code: "custom", message: "Value required" });
    if (s.action === "extract" && !s.output)
      ctx.addIssue({ code: "custom", message: "Typed output required" });
    if (s.value?.source === "secret" && s.action !== "fill")
      ctx.addIssue({ code: "custom", message: "Secrets only support fill" });
  });
export const NAME_PATTERN = "^[\\p{L}\\p{M}][\\p{L}\\p{M} .'\\u2019-]{1,99}$";
export const MemberName = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .regex(
    new RegExp(NAME_PATTERN, "u"),
    "Use a name containing letters, spaces, apostrophes or hyphens",
  );
export const Inputs = z
  .object({
    member_id: z
      .string()
      .regex(/^\d{7}$/, "member_id must contain exactly seven digits")
      .optional(),
    member_name: MemberName.optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.member_id) !== Boolean(v.member_name),
    "Supply exactly one of member_id or member_name",
  );
export const GeneralInputs = z
  .record(ParameterKey, z.string().max(2000))
  .superRefine((v, ctx) => {
    if (Object.keys(v).length > 30)
      ctx.addIssue({ code: "custom", message: "At most 30 inputs" });
    if (v.member_id && !/^\d{7}$/.test(v.member_id))
      ctx.addIssue({ code: "custom", message: "Invalid member ID" });
    if (v.member_name && !MemberName.safeParse(v.member_name).success)
      ctx.addIssue({ code: "custom", message: "Invalid member name" });
    if (v.member_id && v.member_name)
      ctx.addIssue({ code: "custom", message: "Supply ID or name, not both" });
    if (v.account_suffix && !/^[A-Z]\d{2}$/.test(v.account_suffix))
      ctx.addIssue({ code: "custom", message: "Invalid account suffix" });
  });
export const GeneralCompletion = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(500),
    outputs: z.array(OutputDefinition).max(20),
    successCondition: z.array(Checkpoint).min(2).max(20),
  })
  .strict();
export const Capability = z
  .object({
    schemaVersion: z.enum(["1.0", "1.1", "2.0"]),
    capabilityId: z.string().regex(/^[a-z][a-z0-9-]{0,80}$/),
    name: z.string().min(1),
    description: z.string().min(1),
    target: z
      .object({
        application: z.literal("RFCU Member Services"),
        vendor: z.literal("RFCU"),
        applicationVersion: z.string(),
        startUrl: z.string().url(),
        surface: z.literal("web"),
      })
      .strict(),
    inputs: z
      .array(
        z
          .object({
            key: ParameterKey,
            type: z.literal("string"),
            pattern: z.string().max(150).optional(),
            required: z.boolean(),
            description: z.string(),
          })
          .strict(),
      )
      .max(30),
    outputs: z.array(OutputDefinition).max(20),
    steps: z.array(Step).min(3).max(80),
    successCondition: z.array(Checkpoint).min(2),
    safety: z
      .object({
        allowedOrigins: z.array(z.string().url()).min(1),
        allowedRoutes: z.array(z.string()).min(1),
        allowedActions: z.array(ActionType),
        riskLevel: z.enum(["safe", "sensitive", "irreversible"]),
      })
      .strict(),
    metadata: z
      .object({
        createdAt: z.string().datetime(),
        source: z.literal("llm-discovery"),
        artifactVersion: z.number().int().positive(),
        discoveryRunId: z.string().uuid(),
        modelProvider: z.string(),
        model: z.string(),
      })
      .strict(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const general = a.schemaVersion === "2.0";
    if (general) {
      const keys = new Set(a.inputs.map((i) => i.key));
      if (
        keys.size !== a.inputs.length ||
        new Set(a.outputs.map((o) => o.key)).size !== a.outputs.length
      )
        ctx.addIssue({
          code: "custom",
          message: "Duplicate input/output keys",
        });
      for (const step of a.steps) {
        if (step.value?.source === "input" && !keys.has(step.value.key))
          ctx.addIssue({ code: "custom", message: "Undeclared input" });
        if (
          step.action === "extract" &&
          !a.outputs.some(
            (o) =>
              o.key === step.output && o.type === (step.outputType ?? "money"),
          )
        )
          ctx.addIssue({
            code: "custom",
            message: "Undeclared output or type mismatch",
          });
      }
      for (const output of a.outputs)
        if (
          !a.successCondition.some(
            (c) =>
              c.kind === "output" &&
              c.key === output.key &&
              c.type === output.type,
          )
        )
          ctx.addIssue({
            code: "custom",
            message: "Output checkpoint required",
          });
      for (const cp of [
        ...a.successCondition,
        ...a.steps.flatMap((s) =>
          s.precondition
            ? [s.precondition, s.expectedState]
            : [s.expectedState],
        ),
      ]) {
        if (cp.kind === "field_value" && !keys.has(cp.value.key))
          ctx.addIssue({
            code: "custom",
            message: "Checkpoint references undeclared input",
          });
        if (
          cp.kind === "output" &&
          !a.outputs.some((o) => o.key === cp.key && o.type === cp.type)
        )
          ctx.addIssue({
            code: "custom",
            message: "Checkpoint references undeclared output",
          });
      }
      if (
        !a.successCondition.some(
          (c) => c.kind !== "authenticated" && c.kind !== "output",
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Final UI checkpoint required",
        });
    }
    if (!general) {
      if (
        a.inputs.length !== 1 ||
        a.outputs.length !== 1 ||
        a.outputs[0]?.key !== "savings_balance"
      )
        ctx.addIssue({
          code: "custom",
          message: "Legacy savings contract required",
        });
      const byName = a.inputs[0]?.key === "member_name";
      if (
        (byName && a.schemaVersion !== "1.1") ||
        (!byName && a.inputs[0]?.pattern !== "^\\d{7}$")
      )
        ctx.addIssue({
          code: "custom",
          message: "Input contract does not match schema version",
        });
      if (byName && a.inputs[0]?.pattern !== NAME_PATTERN)
        ctx.addIssue({
          code: "custom",
          message: "Unsupported member-name pattern",
        });
      const resolutionIndex = a.steps.findIndex(
        (s) => s.expectedState.kind === "member_resolved",
      );
      const searchIndex = a.steps.findIndex(
        (s) => s.action === "fill" && s.value?.source === "input",
      );
      const extractionIndex = a.steps.findIndex((s) => s.action === "extract");
      if (
        byName &&
        (resolutionIndex <= searchIndex || resolutionIndex >= extractionIndex)
      )
        ctx.addIssue({
          code: "custom",
          message: "Name search requires a unique-member checkpoint",
        });
    }
    if (new Set(a.steps.map((s) => s.id)).size !== a.steps.length)
      ctx.addIssue({ code: "custom", message: "Duplicate step IDs" });
    for (const key of ["RFCU_STAFF_USERNAME", "RFCU_STAFF_PASSWORD"])
      if (
        !a.steps.some(
          (s) => s.value?.source === "secret" && s.value.key === key,
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "UI login secret references required",
        });
    if (!a.steps.some((s) => s.expectedState.kind === "authenticated"))
      ctx.addIssue({
        code: "custom",
        message: "Authentication checkpoint required",
      });
    if (!general && !a.steps.some((s) => s.action === "extract"))
      ctx.addIssue({ code: "custom", message: "Extraction required" });
    if (
      !general &&
      !a.steps.some(
        (s) =>
          s.action === "fill" &&
          s.value?.source === "input" &&
          s.value.key === a.inputs[0]?.key,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Parameterized member search required",
      });
    if (
      !a.successCondition.some((c) => c.kind === "authenticated") ||
      (!general && !a.successCondition.some((c) => c.kind === "output"))
    )
      ctx.addIssue({
        code: "custom",
        message: "Success must verify authentication and typed output",
      });
  });
export const Decision = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("act"),
      summary: z.string().max(300),
      step: Step,
    })
    .strict(),
  z
    .object({
      kind: z.literal("finish"),
      summary: z.string().max(300),
      completion: GeneralCompletion.optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("escalate"), summary: z.string().max(300) })
    .strict(),
  z
    .object({ kind: z.literal("blocked"), summary: z.string().max(300) })
    .strict(),
]);
export type CapabilityArtifact = z.infer<typeof Capability>;
export type CapabilityStep = z.infer<typeof Step>;
export type TargetSpec = z.infer<typeof Target>;
export type CheckpointSpec = z.infer<typeof Checkpoint>;
export type InputValues = {
  member_id?: string;
  member_name?: string;
  [key: string]: string | undefined;
};
export type OutputValue =
  | Money
  | string
  | number
  | boolean
  | Record<string, string>[];
export type ModelDecision = z.infer<typeof Decision>;
export type SessionState =
  | "unauthenticated"
  | "authenticating"
  | "authenticated"
  | "expired"
  | "blocked";
export type ControlOwner = "automation" | "human" | "paused";
export type Money = { amount: string; currency: "USD" };
export type RunResult =
  | {
      status: "success";
      outputs: Record<string, OutputValue>;
      runId: string;
      humanInterventions: number;
    }
  | { status: "business_outcome"; code: string; message: string; runId: string }
  | {
      status: "failure";
      errorType: string;
      stepId: string;
      expected?: unknown;
      observed?: unknown;
      message: string;
      runId: string;
    };
