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
  translationOf?: string;
};

export type BlogPost = BlogPostPreview & {
  content: string;
  translationSlug?: string;
};

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: normalized };

  const yaml = match[1];
  const body = match[2];

  const frontmatter: Record<string, unknown> = {};
  let currentKey = "";

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const listMatch = trimmed.match(/^-\s+(.+)$/);
    if (listMatch) {
      let val = listMatch[1];
      if (val.startsWith("'") && val.endsWith("'") && val.length > 1) val = val.slice(1, -1);
      if (val.startsWith('"') && val.endsWith('"') && val.length > 1) val = val.slice(1, -1);
      if (currentKey) {
        if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = [];
        if (val) (frontmatter[currentKey] as string[]).push(val);
      }
      continue;
    }

    const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (kvMatch) {
      const [, key, val] = kvMatch;
      let clean = val.trim();
      const wasQuoted = (clean.startsWith("'") || clean.startsWith('"')) && clean.length > 1;
      if (clean.startsWith("'") && clean.endsWith("'") && clean.length > 1) clean = clean.slice(1, -1);
      if (clean.startsWith('"') && clean.endsWith('"') && clean.length > 1) clean = clean.slice(1, -1);
      frontmatter[key] = clean === "" && !wasQuoted ? true : clean;
      currentKey = key;
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
  const translationOf = (frontmatter.translationOf as string) || undefined;
  const lang = ((frontmatter.lang as string) || "es").toLowerCase() as "en" | "es";
  const excerpt = body
    .replace(/^#+\s+.*$/m, "")
    .replace(/\n+/g, " ")
    .trim()
    .split(/[.!?]\s/)[0]
    .trim()
    .slice(0, 200) || title;

  if (!slug || !title) return null;
  return { slug, title, date, tags, cover, excerpt, lang, translationOf };
}

export async function getPosts(): Promise<BlogPostPreview[]> {
  try {
    const dir = await fs.readdir(POSTS_DIR);
    const mdFiles = dir.filter((f) => f.endsWith(".md"));
    const posts: BlogPostPreview[] = [];

    for (const file of mdFiles) {
      try {
        const raw = await fs.readFile(path.join(POSTS_DIR, file), "utf-8");
        const { frontmatter, body } = parseFrontmatter(raw);
        const status = (frontmatter.status as string) || "";
        if (status !== "published") continue;
        const preview = extractPreview(frontmatter, body);
        if (preview) posts.push(preview);
      } catch {}
    }

    posts.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return posts;
  } catch {
    return [];
  }
}

export async function getPostBySlug(slug: string): Promise<BlogPost | null> {
  try {
    const dir = await fs.readdir(POSTS_DIR);
    const mdFiles = dir.filter((f) => f.endsWith(".md"));

    let post: BlogPost | null = null;

    for (const file of mdFiles) {
      try {
        const raw = await fs.readFile(path.join(POSTS_DIR, file), "utf-8");
        const { frontmatter, body } = parseFrontmatter(raw);
        const fileSlug = (frontmatter.slug as string) || "";
        const status = (frontmatter.status as string) || "";

        if (fileSlug !== slug || status !== "published") continue;

        const preview = extractPreview(frontmatter, body);
        if (!preview) return null;

        const content = await marked.parse(body, { async: false });
        post = { ...preview, content };
        break;
      } catch {}
    }

    if (!post) return null;

    if (post.translationOf) {
      post.translationSlug = post.translationOf;
    } else {
      for (const file of mdFiles) {
        try {
          const raw = await fs.readFile(path.join(POSTS_DIR, file), "utf-8");
          const { frontmatter, body } = parseFrontmatter(raw);
          const status = (frontmatter.status as string) || "";
          const otherTranslationOf = (frontmatter.translationOf as string) || "";
          if (otherTranslationOf === post.slug && status === "published") {
            post.translationSlug = (frontmatter.slug as string) || "";
            break;
          }
        } catch {}
      }
    }

    return post;
  } catch {
    return null;
  }
}
