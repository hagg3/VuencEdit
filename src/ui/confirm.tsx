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
import { IS_MAC } from "../ribbon/tokens";
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

export type UnsavedChoice = "save" | "discard" | "cancel";

/** What a key does in a confirm. Return never activates a destructive button: neutral → OK; the
 *  three-button unsaved sheet → Save; danger → Cancel. ⌘D is Don't Save on a Mac sheet only. */
export function confirmKeyAction(
  kind: "neutral" | "danger" | "unsaved", key: string, mac: boolean, cmd = false,
): "ok" | "cancel" | "discard" | null {
  if (key === "Enter") return kind === "danger" ? "cancel" : "ok";
  if (kind === "unsaved" && mac && cmd && key.toLowerCase() === "d") return "discard";
  return null;
}

type Pending =
  | (ConfirmOpts & { message: string; resolve: (ok: boolean) => void; unsaved?: undefined })
  | { unsaved: true; title: string; message: string; resolve: (c: UnsavedChoice) => void };

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

/** The Mac-style "Do you want to save the changes?" sheet: Don't Save · Cancel · Save. */
export function unsavedChangesDialog(worldName: string): Promise<UnsavedChoice> {
  return new Promise(resolve => {
    queue = [...queue, {
      unsaved: true, resolve,
      title: `Do you want to save the changes made to \u201c${worldName}\u201d?`,
      message: "Your changes will be lost if you don\u2019t save them.",
    }];
    emit();
  });
}

/** Is a confirm showing? For App's `anyModalOpen` (editor shortcuts must not fire underneath). */
export function useConfirmOpen(): boolean {
  return useSyncExternalStore(subscribe, () => current() != null, () => false);
}

function settle(ok: boolean | UnsavedChoice) {
  const head = queue[0];
  if (!head) return;
  queue = queue.slice(1);
  emit();
  if (head.unsaved) head.resolve(typeof ok === "string" ? ok : ok ? "save" : "cancel");
  else head.resolve(ok === true || ok === "save");
}

export default function ConfirmHost() {
  const req = useSyncExternalStore(subscribe, current, () => null);

  // Return never confirms a destructive action: the default button holds initial focus (so Enter
  // and Space land on it natively); this capture listener only adds ⌘D (Don't Save, Mac) and keeps
  // Enter from reaching a stray focused control behind the dialog.
  useEffect(() => {
    if (!req) return;
    const kind = req.unsaved ? "unsaved" : req.kind === "danger" ? "danger" : "neutral";
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const act = confirmKeyAction(kind, e.key, IS_MAC, e.metaKey);
      if (act === "discard") { e.preventDefault(); e.stopPropagation(); settle("discard"); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [req]);

  if (!req) return null;
  if (req.unsaved) {
    return (
      <Dialog
        size="sm" icon="save" title={req.title} zIndex={3000}
        onClose={() => settle("cancel")}
        footer={<>
          <DialogButton variant="danger" onClick={() => settle("discard")} style={{ marginRight: "auto" }}>
            Don{"\u2019"}t Save
          </DialogButton>
          <DialogButton onClick={() => settle("cancel")}>Cancel</DialogButton>
          <DialogButton variant="primary" autoFocus onClick={() => settle("save")}>Save</DialogButton>
        </>}
      >
        <p style={{ margin: 0, lineHeight: 1.5 }}>{req.message}</p>
      </Dialog>
    );
  }
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
        <DialogButton autoFocus={danger} onClick={() => settle(false)}>{req.cancelLabel ?? "Cancel"}</DialogButton>
        <DialogButton variant={danger ? "danger" : "primary"} autoFocus={!danger} onClick={() => settle(true)}>
          {req.okLabel ?? "OK"}
        </DialogButton>
      </>}
    >
      <p style={{ margin: 0, lineHeight: 1.5 }}>{req.message}</p>
    </Dialog>
  );
}
