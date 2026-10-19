export type Logger = (message: string) => void;

export const consoleLogger: Logger = (message) => {
  const time = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[${time}] ${message}\n`);
};

export const silentLogger: Logger = () => {};

export function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
