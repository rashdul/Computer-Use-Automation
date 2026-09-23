import { config } from "dotenv";
config({ path: "automation.env.local", quiet: true } as Parameters<
  typeof config
>[0]);
export const settings = {
  origin: (process.env.RFCU_ORIGIN ?? "http://localhost:5173").replace(
    /\/$/,
    "",
  ),
  port: Number(process.env.OPERATOR_PORT ?? 4310),
};
