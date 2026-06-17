import React from "react";
import { createRoot } from "react-dom/client";
import AuthGate from "./AuthGate";
import ProductManager from "./ProductManager"; // copy the prototype here, storage->db

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthGate>
      <ProductManager />
    </AuthGate>
  </React.StrictMode>,
);
