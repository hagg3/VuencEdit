import Dialog, { DialogButton } from "./ui/Dialog";
import AboutPanel from "./panels/AboutPanel";

/**
 * Thin `Dialog` wrapper around `AboutPanel`. The application menu shows the same panel in its
 * About pane; this modal survives because the splash screen has no ribbon to open that menu from.
 */
export default function AboutModal({ version, onClose, onOpenDiagnostics }: {
  version: string; onClose: () => void; onOpenDiagnostics?: () => void;
}) {
  return (
    <Dialog
      size="sm" icon="about" title="About VuencEdit" onClose={onClose}
      footer={<DialogButton variant="primary" onClick={onClose}>Close</DialogButton>}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "8px 4px" }}>
        <AboutPanel version={version} onOpenDiagnostics={onOpenDiagnostics} />
      </div>
    </Dialog>
  );
}
