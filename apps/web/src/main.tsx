import React from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { App } from "./App";
import "./index.css";

// Force dark mode
document.documentElement.classList.add("dark");

createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <Toaster richColors theme="dark" />
  </>
);
