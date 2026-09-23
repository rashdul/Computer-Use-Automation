// Intentionally no provider/discovery imports. Replay has no model dependency.
import { readFile } from "node:fs/promises";
import { Capability, type CapabilityArtifact } from "./schema.js";
import { RuntimeCondition } from "./errors.js";
import type { Run } from "./runtime.js";
export async function loadCapability(id: string) {
  if (!/^[a-z][a-z0-9-]{0,80}$/.test(id))
    throw new RuntimeCondition("INVALID_CAPABILITY", "Invalid capability ID");
  try {
    return Capability.parse(
      JSON.parse(await readFile(`artifacts/${id}.json`, "utf8")),
    );
  } catch {
    throw new RuntimeCondition(
      "INVALID_CAPABILITY",
      "Capability is missing or does not satisfy a supported schema",
    );
  }
}
export async function replay(run: Run, artifact: CapabilityArtifact) {
  try {
    Capability.parse(artifact);
    const inputKey = run.inputs.member_name ? "member_name" : "member_id";
    if (artifact.inputs[0].key !== inputKey)
      throw new RuntimeCondition(
        "INPUT_CAPABILITY_MISMATCH",
        "Choose a capability discovered for this search type (member number or name)",
      );
    if (artifact.target.startUrl !== run.policy.origin + "/login")
      throw new RuntimeCondition(
        "POLICY_DENIED",
        "Capability must start at configured RFCU login",
      );
    if (!artifact.safety.allowedOrigins.includes(run.policy.origin))
      throw new RuntimeCondition(
        "POLICY_DENIED",
        "Artifact does not permit configured origin",
      );
    for (const step of artifact.steps) {
      if (!artifact.safety.allowedActions.includes(step.action))
        throw new RuntimeCondition(
          "POLICY_DENIED",
          "Artifact action allowlist rejected a step",
        );
    }
    await run.start();
    await run.evidence.event("capability_loaded", {
      capabilityId: artifact.capabilityId,
      artifactVersion: artifact.metadata.artifactVersion,
      llmEnabled: false,
    });
    for (const step of artifact.steps) await run.step(step);
    for (const cp of artifact.successCondition)
      await run.surface.checkpoint(cp, run.outputs);
    return run.finish();
  } catch (error) {
    return run.finish(error);
  }
}
