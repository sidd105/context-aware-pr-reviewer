export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export function consoleLogger(options: { verbose?: boolean; quiet?: boolean } = {}): Logger {
  return {
    info: (m) => {
      if (!options.quiet) process.stderr.write(`${m}\n`);
    },
    warn: (m) => process.stderr.write(`warning: ${m}\n`),
    debug: (m) => {
      if (options.verbose) process.stderr.write(`debug: ${m}\n`);
    },
  };
}

export function silentLogger(): Logger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: (m) => messages.push(`info: ${m}`),
    warn: (m) => messages.push(`warn: ${m}`),
    debug: () => {},
  };
}
