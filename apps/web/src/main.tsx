import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

/** Mount the app. */
createRoot(document.getElementById("root")!).render(<App />);
