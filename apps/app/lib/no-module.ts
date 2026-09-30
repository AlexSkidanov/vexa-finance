// Stands in for Node's `module` in the browser bundle. See next.config.ts.
export function createRequire(): never {
  throw new Error('Agent payment proofs run in Node, not in the browser');
}
