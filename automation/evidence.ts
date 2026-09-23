import { mkdir, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Secrets, parameterize, redactPII } from "./secrets.js";
import type { InputValues } from "./schema.js";
export class Evidence {
  readonly events: unknown[] = [];
  constructor(
    readonly runId: string,
    readonly directory: string,
    private secrets: Secrets,
    private inputs: InputValues,
  ) {}
  clean(value: unknown) {
    return JSON.parse(
      redactPII(
        parameterize(this.secrets.redact(JSON.stringify(value)), this.inputs),
      ),
    );
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
  }
  async event(type: string, data: unknown = {}) {
    const event = this.clean({
      timestamp: new Date().toISOString(),
      runId: this.runId,
      type,
      ...(data as object),
    });
    this.events.push(event);
    await appendFile(
      path.join(this.directory, "events.jsonl"),
      JSON.stringify(event) + "\n",
    );
  }
  async save(name: string, value: unknown) {
    await writeFile(
      path.join(this.directory, name),
      JSON.stringify(this.clean(value), null, 2) + "\n",
    );
  }
}
