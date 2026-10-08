import z from "@deepseek-ai/schemastery";
import { Context, Volatile } from "@deepseek-ai/cordis";
//#region src/contract.d.ts
declare const PROVIDER = "codebuddy";
//#endregion
//#region src/index.d.ts
declare const name = "llm-codebuddy";
declare const inject: string[];
declare const CREDENTIAL_REF: import("@deepseek-ai/dsh-credentials").CredentialRef;
declare const Config: z<Schemastery.ObjectS<NoInfer<{
  defaultSite: z<string, string, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  defaultSite: z<string, string, "volatile-defined">;
}>>, "plain">;
declare function apply(ctx: Context, config?: {
  defaultSite: Volatile<string>;
}): void;
//#endregion
export { CREDENTIAL_REF, Config, PROVIDER, apply, inject, name };