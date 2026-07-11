import { defineConfig } from "astro/config";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import vercel from "@astrojs/vercel";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import tina from "@tinacms/astro/integration";

const SITE = process.env.SITE_URL || "http://localhost:4321";
const POSTS_DIR = resolve(process.cwd(), "content/posts");

function blogSlugs() {
  try {
    const files = readdirSync(POSTS_DIR).filter((f) => f.endsWith(".md"));
    const slugs = [];
    for (const file of files) {
      const raw = readFileSync(resolve(POSTS_DIR, file), "utf-8");
      const m = raw.match(/^---\n[\s\S]*?\nslug:\s*(.+)\n[\s\S]*?\n---\n/);
      if (m) {
        const slug = m[1].replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1").trim();
        if (slug) slugs.push(slug);
      }
    }
    return slugs;
  } catch {
    return [];
  }
}

const postSlugs = blogSlugs();

export default defineConfig({
  site: SITE,
  output: "static",
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
      customPages: postSlugs.flatMap((slug) => [
        `en/blog/${slug}`,
        `es/blog/${slug}`,
      ]).map((p) => `${SITE}/${p}`),
    }),
    tina(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
