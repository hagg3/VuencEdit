import Dialog from "./ui/Dialog";
import WorldInfoPanel from "./panels/WorldInfoPanel";

/**
 * Thin `Dialog` wrapper around `WorldInfoPanel` — the same content the application menu's
 * Properties pane renders, so the two can't drift.
 */
export default function WorldInfoModal({ onClose }: { onClose: () => void }) {
  return (
    <Dialog size="md" icon="properties" title="World Info" onClose={onClose}>
      <WorldInfoPanel />
    </Dialog>
  );
}
