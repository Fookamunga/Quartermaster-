function ts(): string {
  return new Date().toISOString();
}

export const logger = {
  info(msg: string, meta?: Record<string, unknown>): void {
    console.log(`[${ts()}] INFO  ${msg}`, meta ? JSON.stringify(meta) : "");
  },
  warn(msg: string, meta?: Record<string, unknown>): void {
    console.warn(`[${ts()}] WARN  ${msg}`, meta ? JSON.stringify(meta) : "");
  },
  error(msg: string, meta?: Record<string, unknown>): void {
    console.error(`[${ts()}] ERROR ${msg}`, meta ? JSON.stringify(meta) : "");
  },
};
