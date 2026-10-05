export function log(scope: string, msg: string, data?: Record<string, unknown>) {
  const ts = new Date().toISOString().slice(11, 19);
  const extra = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${ts}] [${scope}] ${msg}${extra}`);
}
