import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      output: {
        // vendor code changes rarely; keep it cacheable apart from the app
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client", "react-router"],
          data: ["@supabase/supabase-js", "@tanstack/react-query"],
        },
      },
    },
  },
});
