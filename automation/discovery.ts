import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import {
  Capability,
  NAME_PATTERN,
  Step,
  type CapabilityArtifact,
  type CapabilityStep,
} from "./schema.js";
import { parameterize } from "./secrets.js";
import { RuntimeCondition } from "./errors.js";
import type { DecisionProvider } from "./providers.js";
import type { Run } from "./runtime.js";

export async function discover(
  run: Run,
  provider: DecisionProvider,
  capabilityId = "get-member-savings-balance",
) {
  const steps: CapabilityStep[] = [];
  const inputKey = run.inputs.member_name ? "member_name" : "member_id";
  try {
    await run.start();
    await run.evidence.event("discovery_provider", {
      provider: provider.name,
      model: provider.model,
    });
    let repetitions = 0,
      last = "";
    for (let index = 0; index < 30; index++) {
      const observation = await run.surface.condition();
      await run.evidence.event("observe", { observation, index });
      const prompt = JSON.stringify(
        run.evidence.clean({
          goal: run.goal,
          inputs: { [inputKey]: "{{" + inputKey + "}}" },
          observation,
          completedSteps: steps,
          outputs: run.outputs,
        }),
        null,
        2,
      );
      run.modelCalls++;
      const decisionStarted = Date.now();
      const decision = await provider.decide(prompt);
      await run.evidence.event("model_decision", {
        provider: provider.name,
        model: provider.model,
        index,
        decision,
        durationMs: Date.now() - decisionStarted,
      });
      if (decision.kind === "blocked")
        throw new RuntimeCondition(
          "MODEL_BLOCKED",
          "Discovery reported that the requested goal is blocked",
        );
      if (decision.kind === "escalate") {
        await run.handoff(decision.summary);
        continue;
      }
      if (decision.kind === "finish") {
        const successCondition: CapabilityArtifact["successCondition"] = [
          { kind: "authenticated" },
          {
            kind: "route",
            path: "/members/{{member_id}}/accounts/{{member_id}}-S00",
          },
          { kind: "output", key: "savings_balance", type: "money" },
        ];
        for (const cp of successCondition)
          await run.surface.checkpoint(cp, run.outputs);
        let version = 1;
        try {
          version =
            Capability.parse(
              JSON.parse(
                await readFile(
                  path.join("artifacts", capabilityId + ".json"),
                  "utf8",
                ),
              ),
            ).metadata.artifactVersion + 1;
        } catch {}
        const artifact = Capability.parse({
          schemaVersion: inputKey === "member_name" ? "1.1" : "1.0",
          capabilityId,
          name: "Get member savings balance",
          description:
            "Authenticate through RFCU and return the requested member’s primary savings share (S00) current balance.",
          target: {
            application: "RFCU Member Services",
            vendor: "RFCU",
            applicationVersion: "4.12.2",
            startUrl: run.policy.origin + "/login",
            surface: "web",
          },
          inputs: [
            {
              key: inputKey,
              type: "string",
              pattern: inputKey === "member_id" ? "^\\d{7}$" : NAME_PATTERN,
              required: true,
              description:
                inputKey === "member_id"
                  ? "Seven-digit RFCU member number"
                  : "Member name (2-100 characters); must resolve to exactly one search result",
            },
          ],
          outputs: [
            {
              key: "savings_balance",
              type: "money",
              currency: "USD",
              description:
                "Primary savings S00 current balance, decimal string preserving cents",
            },
          ],
          steps,
          successCondition,
          safety: {
            allowedOrigins: run.policy.origins,
            allowedRoutes: run.policy.routes,
            allowedActions: run.policy.actions,
            riskLevel: "safe",
          },
          metadata: {
            createdAt: new Date().toISOString(),
            source: "llm-discovery",
            artifactVersion: version,
            discoveryRunId: run.runId,
            modelProvider: provider.name,
            model: provider.model,
          },
        });
        const serialized = JSON.stringify(artifact, null, 2) + "\n";
        run.secrets.assertAbsent(serialized);
        if (/\b\d{7}\b|\$\d/.test(serialized))
          throw new RuntimeCondition(
            "ARTIFACT_DATA_LEAK",
            "Artifact contains an unparameterized member ID or balance",
          );
        await mkdir("artifacts", { recursive: true });
        await writeFile(
          path.join("artifacts", capabilityId + ".json"),
          serialized,
        );
        await run.evidence.save("capability.json", artifact);
        await run.evidence.event("capability_saved", {
          capabilityId,
          artifactVersion: version,
        });
        return run.finish();
      }
      const normalized = JSON.parse(
        parameterize(JSON.stringify(decision.step), run.inputs),
      );
      const step = Step.parse(normalized);
      run.secrets.assertAbsent(JSON.stringify(step));
      const signature = JSON.stringify({
        action: step.action,
        target: step.target,
        value: step.value,
      });
      repetitions = signature === last ? repetitions + 1 : 0;
      last = signature;
      if (repetitions >= 2) {
        await run.handoff(
          "Discovery repeated the same action without progress",
        );
        repetitions = 0;
      }
      if (steps.some((s) => s.id === step.id))
        throw new RuntimeCondition(
          "MODEL_OUTPUT_INVALID",
          "Step IDs must be unique",
        );
      await run.step(step);
      steps.push(step);
    }
    throw new RuntimeCondition(
      "DISCOVERY_LIMIT",
      "Discovery exceeded the 30-decision limit",
    );
  } catch (error) {
    return run.finish(error);
  }
}
