import { defineConfig } from "vite";

export default defineConfig({
  base: "/Objetc_Shading/",
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        // add more entry points as needed
      },
    },
  },
});