/** Structured JSON logging compatible with Cloud Logging (severity + message). */
type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

let silent = false;
export function setSilent(v: boolean) {
  silent = v;
}

function emit(severity: Severity, message: string, extra?: Record<string, unknown>) {
  if (silent) return;
  const line = JSON.stringify({ severity, message, time: new Date().toISOString(), ...extra });
  if (severity === 'ERROR') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (m: string, x?: Record<string, unknown>) => emit('DEBUG', m, x),
  info: (m: string, x?: Record<string, unknown>) => emit('INFO', m, x),
  warn: (m: string, x?: Record<string, unknown>) => emit('WARNING', m, x),
  error: (m: string, x?: Record<string, unknown>) => emit('ERROR', m, x),
};
