/**
 * Lets the root error boundary (`RootErrorBoundary.tsx`) reach the app's Save after `App` itself has
 * thrown and unmounted. The Rust side still holds the world and its undo stack, so a save is still
 * possible; only `App`'s own closure (`saveWorld`/`saveWorldAs`, which know the source path) can
 * perform one. `App` registers that closure here on every render that changes it, and never
 * clears it on unmount: surviving the unmount is the whole point.
 */
export type RootSaveHandler = () => Promise<boolean> | boolean | void;

let handler: RootSaveHandler | null = null;

export function registerRootSave(fn: RootSaveHandler | null): void { handler = fn; }
export function hasRootSave(): boolean { return handler != null; }

/** Runs the registered save. Resolves true if it reports success (or returns nothing). */
export async function runRootSave(): Promise<boolean> {
  if (!handler) return false;
  const r = await handler();
  return r !== false;
}
