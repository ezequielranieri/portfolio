import { defineConfig } from "astro/config";
import vercel from "@astrojs/vercel";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import tina from "@tinacms/astro/integration";

const SITE = process.env.SITE_URL || "http://localhost:4321";

export default defineConfig({
  site: SITE,
  output: "server",
  adapter: vercel(),
  i18n: {
    defaultLocale: "es",
    locales: ["en", "es"],
    routing: {
      prefixDefaultLocale: true,
    },
  },
  integrations: [
    sitemap({
      customPages: [
        "en/blog/understanding-iam",
        "en/blog/distributed-systems-patterns",
        "en/blog/arquitectura-hexagonal",
        "es/blog/understanding-iam",
        "es/blog/distributed-systems-patterns",
        "es/blog/arquitectura-hexagonal",
      ].map((p) => `${SITE}/${p}`),
    }),
    tina(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
