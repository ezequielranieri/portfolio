import rss from "@astrojs/rss";
import { getPosts } from "../lib/posts";

export const prerender = true;

export async function GET() {
  const posts = await getPosts();
  const site = process.env.SITE_URL || "http://localhost:4321";

  return rss({
    title: "Ezequiel Ranieri — Blog",
    description: "Backend & Security Engineer — distributed systems, IAM, and security engineering.",
    site,
    items: posts.map((p) => ({
      title: p.title,
      description: p.excerpt,
      pubDate: new Date(p.date),
      link: `/${p.lang}/blog/${p.slug}`,
      categories: p.tags,
    })),
    customData: "<language>en</language>",
  });
}
