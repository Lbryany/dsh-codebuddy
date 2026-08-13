import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
declare const name = "llm-codebuddy";
declare const inject: string[];
declare const PROVIDER = "codebuddy";
declare const CREDENTIAL_REF: import("@deepseek-ai/dsh-credentials").CredentialRef;
declare function apply(ctx: Context): void;
//#endregion
export { CREDENTIAL_REF, PROVIDER, apply, inject, name };
//# sourceMappingURL=index.d.mts.map