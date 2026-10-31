export const PRODUCT = "xaq";

/** `XAQ_<name>`. */
export const envVar = (name: string, env: NodeJS.ProcessEnv = process.env): string | undefined => env[`XAQ_${name}`];

/** Whether this process runs under `service install` (XAQ_SERVICE=1). */
export const underService = (env: NodeJS.ProcessEnv = process.env) => envVar("SERVICE", env) === "1";
