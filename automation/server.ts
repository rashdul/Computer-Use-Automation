import express from "express";
import { readdir, readFile } from "node:fs/promises";
import { z } from "zod";
import { settings } from "./config.js";
import { Inputs } from "./schema.js";
import { Secrets } from "./secrets.js";
import { Policy, ROUTES } from "./policy.js";
import { Run } from "./runtime.js";
import { discover } from "./discovery.js";
import { replay, loadCapability } from "./replay.js";
import { providerFromEnv } from "./providers.js";
import { RuntimeCondition } from "./errors.js";

const app = express();
const runs = new Map<string, Run>();
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const hosts = [`localhost:${settings.port}`, `127.0.0.1:${settings.port}`];
  if (!hosts.includes(req.headers.host ?? "")) {
    res.status(403).json({ error: "HOST_DENIED" });
    return;
  }
  if (
    req.headers.origin &&
    !hosts.map((h) => "http://" + h).includes(req.headers.origin)
  ) {
    res.status(403).json({ error: "ORIGIN_DENIED" });
    return;
  }
  if (req.method === "POST" && req.headers["x-rfcu-client"] !== "operator") {
    res.status(403).json({ error: "CLIENT_HEADER_REQUIRED" });
    return;
  }
  next();
});
app.use(express.json({ limit: "32kb" }));
app.get("/", async (_req, res) =>
  res.type("html").send(await readFile("automation/operator.html", "utf8")),
);
app.get("/tokens.css", async (_req, res) =>
  res
    .type("css")
    .send(await readFile("target-app/src/styles/tokens.css", "utf8")),
);
app.get("/api/config", (_req, res) =>
  res.json({
    origin: settings.origin,
    provider: process.env.DISCOVERY_PROVIDER ?? "codex",
  }),
);
app.get("/api/capabilities", async (_req, res) => {
  const files = await readdir("artifacts").catch(() => []);
  const capabilities = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      capabilities.push(await loadCapability(file.slice(0, -5)));
    } catch {}
  }
  res.json(capabilities);
});
const Request = z
  .object({
    mode: z.enum(["discovery", "replay"]),
    goal: z.string().max(1500).optional(),
    startUrl: z.string().url().optional(),
    inputs: Inputs,
    capabilityId: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,80}$/)
      .default("get-member-savings-balance"),
    headed: z.boolean().default(false),
    handoffDemo: z.boolean().default(false),
    evidenceGroup: z
      .enum([
        "discovery",
        "replay-success",
        "replay-error",
        "handoff",
        "verification",
      ])
      .optional(),
  })
  .strict();
app.post("/api/runs", async (req, res) => {
  const input = Request.parse(req.body);
  if (
    input.mode === "discovery" &&
    input.goal &&
    !/savings[\s\S]*balance|balance[\s\S]*savings/i.test(input.goal)
  )
    throw new RuntimeCondition(
      "UNSUPPORTED_GOAL",
      "This implementation supports primary savings balance lookup. Supply a savings-balance goal.",
    );
  if ([...runs.values()].some((r) => !r.result)) {
    res.status(409).json({
      error: "RUN_ACTIVE",
      message: "Finish or resume the active run first",
    });
    return;
  }
  if (input.startUrl && input.startUrl !== settings.origin + "/login")
    throw new RuntimeCondition(
      "POLICY_DENIED",
      "Discovery must begin at the configured /login URL",
    );
  const secrets = await Secrets.load();
  const artifact =
    input.mode === "replay"
      ? await loadCapability(input.capabilityId)
      : undefined;
  const routes = artifact
    ? ROUTES.filter((r) => artifact.safety.allowedRoutes.includes(r))
    : ROUTES;
  const policy = new Policy(settings.origin, input.inputs, routes);
  const provider = input.mode === "discovery" ? providerFromEnv() : undefined;
  // Setup above awaits local files; another request may have started meanwhile.
  // Recheck immediately before registration, with no intervening await.
  if ([...runs.values()].some((r) => !r.result)) {
    res
      .status(409)
      .json({
        error: "RUN_ACTIVE",
        message: "Finish or resume the active run first",
      });
    return;
  }
  const run = new Run(
    input.mode,
    input.inputs,
    secrets,
    policy,
    input.goal ??
      "Log in to RFCU, look up member {{member_id}}, and return their current savings balance.",
    input,
  );
  runs.set(run.runId, run);
  res.status(202).json({
    runId: run.runId,
    operatorUrl: `http://localhost:${settings.port}/`,
  });
  const execution = artifact
    ? replay(run, artifact)
    : discover(run, provider!, input.capabilityId);
  void execution.catch(async () => {
    if (!run.result)
      await run.finish(
        new RuntimeCondition("INTERNAL_ERROR", "Unhandled run failure"),
      );
  });
});
app.get("/api/runs", (_req, res) =>
  res.json(
    [...runs.values()].map((r) => ({
      runId: r.runId,
      mode: r.mode,
      currentStep: r.currentStep,
      owner: r.control.owner,
      status: r.result?.status ?? "running",
    })),
  ),
);
function getRun(id: string) {
  const run = runs.get(id);
  if (!run) throw new RuntimeCondition("RUN_NOT_FOUND", "Run not found");
  return run;
}
app.get("/api/runs/:id", async (req, res) => {
  const run = getRun(req.params.id);
  res.json(
    run.evidence.clean({
      runId: run.runId,
      mode: run.mode,
      goal: run.goal,
      currentStep: run.currentStep,
      owner: run.control.owner,
      session: run.surface?.session.state,
      intervention: run.control.intervention,
      result: run.result,
      modelCalls: run.modelCalls,
      events: run.evidence.events,
    }),
  );
});
app.get("/api/runs/:id/frame", async (req, res) => {
  const run = getRun(req.params.id);
  if (!run.surface || run.result) {
    res.status(409).end();
    return;
  }
  // Live frames are never persisted. Login and staff identity controls are masked.
  res.type("png").send(
    await run.surface.page.screenshot({
      mask: [
        run.surface.page.locator(
          "input,.shell__topbar,.topbar,.sidebar__footer,.shell__user,.sidebar-user",
        ),
      ],
      maskColor: "#c9d6e6",
    }),
  );
});
app.post("/api/runs/:id/takeover", async (req, res) => {
  const run = getRun(req.params.id);
  if (req.headers["x-rfcu-operator"] === "automated-test")
    await run.evidence.event("operator_test_provenance", {
      operator: "automated-ui-test",
      simulatedOperator: true,
    });
  await run.control.takeover();
  res.json({ owner: run.control.owner });
});
app.post("/api/runs/:id/resume", async (req, res) => {
  const run = getRun(req.params.id);
  await run.surface.condition();
  if (
    await run.surface.page
      .locator('[role="alertdialog"],[role="dialog"]')
      .count()
  )
    throw new RuntimeCondition(
      "RESUME_BLOCKED",
      "Resolve the visible dialog before resuming",
    );
  await run.control.resume();
  res.json({ owner: run.control.owner });
});
app.post("/api/runs/:id/human-click", async (req, res) => {
  const run = getRun(req.params.id);
  if (run.control.owner !== "human")
    throw new RuntimeCondition(
      "CONTROL_CONFLICT",
      "Take control before operating the page",
    );
  const { x, y } = z
    .object({ x: z.number().min(0).max(1440), y: z.number().min(0).max(900) })
    .strict()
    .parse(req.body);
  const name = await run.surface.page.evaluate(
    ({ x, y }) =>
      document.elementFromPoint(x, y)?.closest("button")?.textContent?.trim() ??
      "",
    { x, y },
  );
  if (
    ![
      "Resolve demonstration block",
      "Acknowledge",
      "Dismiss",
      "OK, got it",
      "Remind me later",
      "Try again",
    ].includes(name)
  )
    throw new RuntimeCondition(
      "HUMAN_ACTION_DENIED",
      "Use the live browser for other manual work; this console only permits harmless dialog/retry controls",
    );
  await run.surface.page.mouse.click(x, y);
  res.json({ accepted: true });
});
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: "INVALID_INPUT",
        message: "Request does not match the typed API contract",
        fields: err.issues.map((i) => i.path.join(".")),
      });
      return;
    }
    const e =
      err instanceof RuntimeCondition
        ? err
        : new RuntimeCondition(
            "REQUEST_FAILED",
            "Request failed; check local setup",
          );
    res.status(400).json({ error: e.code, message: e.message });
  },
);
const server = app.listen(settings.port, "127.0.0.1", () =>
  console.log(`RFCU operator console: http://localhost:${settings.port}`),
);
async function shutdown() {
  for (const run of runs.values()) await run.surface?.close();
  server.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
