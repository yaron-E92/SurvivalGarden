declare const __dirname: string;

declare module 'node:path' {
  export function resolve(...paths: string[]): string;
}
