import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import RootErrorBoundary from "./RootErrorBoundary";
import ThemeStyle from "./theme/ThemeStyle";
import { installPinchGuard } from "./input/wheel";
import { IS_MAC } from "./ribbon/tokens";

// Windows: WebView2 pinch is re-enabled for the trackpad (34.7); keep it from page-zooming the UI.
if (!IS_MAC) installPinchGuard();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeStyle />
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
