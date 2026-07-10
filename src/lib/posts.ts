import fs from "fs/promises";
import path from "path";
import { marked } from "marked";

const POSTS_DIR = path.resolve(process.cwd(), "content/posts");

export type BlogPostPreview = {
  slug: string;
  title: string;
  date: string;
  tags: string[];
  cover: string;
  excerpt: string;
  lang: "en" | "es";
};

export type BlogPost = BlogPostPreview & {
  content: string;
};

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };

  const yaml = match[1];
  const body = match[2];

  const frontmatter: Record<string, unknown> = {};
  const currentKey: string[] = [];

  for (const line of yaml.split("\n")) {
    const indent = line.match(/^\s*/)[0].length;
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const listMatch = trimmed.match(/^-\s+(.+)$/);
    if (listMatch) {
      const val = listMatch[1].replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
      if (currentKey.length > 0) {
        const key = currentKey[currentKey.length - 1];
        if (!Array.isArray(frontmatter[key])) frontmatter[key] = [];
        (frontmatter[key] as string[]).push(val);
      }
      continue;
    }

    const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (kvMatch) {
      const [, key, val] = kvMatch;
      const clean = val.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
      frontmatter[key] = clean || true;
      currentKey.length = 0;
      currentKey.push(key);
    }
  }

  return { frontmatter, body };
}

function extractPreview(frontmatter: Record<string, unknown>, body: string): BlogPostPreview | null {
  const slug = (frontmatter.slug as string) || "";
  const title = (frontmatter.title as string) || "";
  const date = (frontmatter.date as string) || "";
  const rawTags = frontmatter.tags;
  const tags = Array.isArray(rawTags) ? rawTags.filter(Boolean) as string[] : [];
  const cover = (frontmatter.cover as string) || "";
  const lang = ((frontmatter.lang as string) || "es").toLowerCase() as "en" | "es";
  const excerpt = title;

  if (!slug || !title) return null;
  return { slug, title, date, tags, cover, excerpt, lang };
}

let cachedPosts: BlogPostPreview[] | null = null;

export async function getPosts(): Promise<BlogPostPreview[]> {
  if (cachedPosts) return cachedPosts;

  try {
    const dir = await fs.readdir(POSTS_DIR);
    const mdFiles = dir.filter((f) => f.endsWith(".md"));

    const posts: BlogPostPreview[] = [];

    for (const file of mdFiles) {
      const raw = await fs.readFile(path.join(POSTS_DIR, file), "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);
      const status = (frontmatter.status as string) || "";
      if (status !== "published") continue;
      const preview = extractPreview(frontmatter, body);
      if (preview) posts.push(preview);
    }

    posts.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    cachedPosts = posts;
    return posts;
  } catch {
    return [];
  }
}

export async function getPostBySlug(slug: string): Promise<BlogPost | null> {
  try {
    const filePath = path.join(POSTS_DIR, `${slug}.md`);
    const raw = await fs.readFile(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const status = (frontmatter.status as string) || "";
    if (status !== "published") return null;
    const preview = extractPreview(frontmatter, body);
    if (!preview) return null;

    const content = await marked.parse(body, { async: false });

    return { ...preview, content };
  } catch {
    return null;
  }
}
