declare module 'node:child_process' {
  export function execFileSync(file: string, args: string[], options: { encoding: 'utf8' }): string;
}
