/**
 * In-app confirm dialog — the replacement for `@tauri-apps/plugin-dialog`'s `ask()`, which pops an
 * OS-native alert that looks like nothing else in the app (and, on Windows, like a 2005 message box).
 * Same call shape — `await confirmDialog(message, opts)` resolves `true` for OK — so a call site
 * migrates by changing one identifier. Rendered by the single `<ConfirmHost />` App mounts in both
 * the splash and editor branches; a module-level queue (the `useWindowLayout` store idiom, no new
 * dependency) means it can be awaited from any async handler without prop drilling.
 *
 * File pickers (`open`/`save`) stay native on purpose: those are the OS's file browser, which users
 * expect. This only covers yes/no questions.
 */
import { useEffect, useSyncExternalStore } from "react";
import Dialog, { DialogButton } from "./Dialog";
import type { IconName } from "../ribbon/icons";

export interface ConfirmOpts {
  title: string;
  okLabel?: string;
  cancelLabel?: string;
  /** `danger` = the OK action throws work away (discard changes, overwrite a file). */
  kind?: "neutral" | "danger";
  icon?: IconName;
}

interface Pending extends ConfirmOpts { message: string; resolve: (ok: boolean) => void }

let queue: Pending[] = [];
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const current = () => queue[0] ?? null;

/** Ask a yes/no question in the app's own dialog chrome. Requests queue; one shows at a time. */
export function confirmDialog(message: string, opts: ConfirmOpts): Promise<boolean> {
  return new Promise(resolve => {
    queue = [...queue, { ...opts, message, resolve }];
    emit();
  });
}

/** Is a confirm showing? For App's `anyModalOpen` (editor shortcuts must not fire underneath). */
export function useConfirmOpen(): boolean {
  return useSyncExternalStore(subscribe, () => current() != null, () => false);
}

function settle(ok: boolean) {
  const head = queue[0];
  if (!head) return;
  queue = queue.slice(1);
  emit();
  head.resolve(ok);
}

export default function ConfirmHost() {
  const req = useSyncExternalStore(subscribe, current, () => null);

  // Enter confirms, as the native dialog did. Capture phase so it wins over the focused control
  // (Modal's focus trap starts on the ✕, where Enter would otherwise mean "cancel").
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      settle(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [req]);

  if (!req) return null;
  const danger = req.kind === "danger";
  return (
    <Dialog
      size="sm"
      icon={req.icon ?? (danger ? "warning" : "help")}
      title={req.title}
      // Above every other dialog: a confirm can be raised from inside one (e.g. Upload's save gate).
      zIndex={3000}
      onClose={() => settle(false)}
      footer={<>
        <DialogButton onClick={() => settle(false)}>{req.cancelLabel ?? "Cancel"}</DialogButton>
        <DialogButton variant={danger ? "danger" : "primary"} onClick={() => settle(true)}>
          {req.okLabel ?? "OK"}
        </DialogButton>
      </>}
    >
      <p style={{ margin: 0, lineHeight: 1.5 }}>{req.message}</p>
    </Dialog>
  );
}
