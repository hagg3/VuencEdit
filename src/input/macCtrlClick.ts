/** On macOS a Ctrl+primary-button press is the system's secondary click: the webview fires
 *  `contextmenu` for it. It must open the menu *instead of* starting a stroke (⌘+drag is the
 *  invert chord there). Windows/Linux Ctrl+drag keeps its invert meaning, so this is Mac-only. */
export function isMacCtrlMenuPress(e: { button: number; ctrlKey: boolean }, isMac: boolean): boolean {
  return isMac && e.ctrlKey && e.button === 0;
}
