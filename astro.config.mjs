import { defineConfig } from "astro/config";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import vercel from "@astrojs/vercel";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import tina from "@tinacms/astro/integration";

const SITE = process.env.SITE_URL || "http://localhost:4321";
const POSTS_DIR = resolve(process.cwd(), "content/posts");

function blogPages() {
  try {
    const files = readdirSync(POSTS_DIR).filter((f) => f.endsWith(".md"));
    const pages = [];
    for (const file of files) {
      const raw = readFileSync(resolve(POSTS_DIR, file), "utf-8").replace(/\r\n/g, "\n");
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
      if (!fm) continue;
      const frontmatter = fm[1];
      const slugMatch = frontmatter.match(/^slug:\s*(.+)$/m);
      const langMatch = frontmatter.match(/^lang:\s*(en|es)$/m);
      if (!slugMatch || !langMatch) continue;
      const slug = slugMatch[1].replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1").trim();
      const lang = langMatch[1].trim();
      if (slug && lang) pages.push(`${lang}/blog/${slug}`);
    }
    return pages;
  } catch {
    return [];
  }
}

const postPages = blogPages();

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
      customPages: postPages.map((p) => `${SITE}/${p}`),
    }),
    tina(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
