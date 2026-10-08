import { Context } from "@deepseek-ai/cordis";
//#region src/contract.d.ts
declare const PROVIDER = "codebuddy";
//#endregion
//#region src/index.d.ts
declare const name = "llm-codebuddy";
declare const inject: string[];
declare const CREDENTIAL_REF: import("@deepseek-ai/dsh-credentials").CredentialRef;
declare function apply(ctx: Context): void;
//#endregion
export { CREDENTIAL_REF, PROVIDER, apply, inject, name };