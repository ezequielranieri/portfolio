import { Client } from "@notionhq/client";
import { renderBlocks } from "./notion-renderer";

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

type NotionPage = {
  id: string;
  properties: Record<string, unknown>;
  cover: { file?: { url: string }; external?: { url: string } } | null;
};

function extractPreview(page: NotionPage): BlogPostPreview {
  const props = page.properties as Record<string, { title?: Array<{ plain_text: string }>; rich_text?: Array<{ plain_text: string }>; select?: { name: string }; date?: { start: string }; multi_select?: Array<{ name: string }>; files?: Array<{ file?: { url: string }; external?: { url: string }; name: string }> }>;

  const title = props["Título"]?.title?.[0]?.plain_text || "";
  const slug = props["Slug"]?.rich_text?.[0]?.plain_text || "";
  const date = props["Fecha"]?.date?.start || "";
  const tags = props["Tags"]?.multi_select?.map((t) => t.name) || [];
  const coverUrl = props["Cover"]?.files?.[0]?.file?.url || props["Cover"]?.files?.[0]?.external?.url || (page.cover?.file?.url || page.cover?.external?.url || "");
  const lang = (props["Idioma"]?.select?.name || "es").toLowerCase() as "en" | "es";

  return { slug, title, date, tags, cover: coverUrl, excerpt: title, lang };
}

function extractPreviewFromApi(page: Record<string, unknown>): BlogPostPreview | null {
  try {
    const p = page as NotionPage;
    return extractPreview(p);
  } catch {
    return null;
  }
}

const PLACEHOLDER_POSTS: BlogPostPreview[] = [
  {
    slug: "understanding-iam",
    title: "Understanding Identity & Access Management",
    date: "2026-06-01",
    tags: ["IAM", "Security"],
    cover: "",
    excerpt: "An introduction to IAM concepts, protocols, and architectural patterns for building secure authentication and authorization systems.",
    lang: "en",
  },
  {
    slug: "distributed-systems-patterns",
    title: "Patterns for Resilient Distributed Systems",
    date: "2026-05-15",
    tags: ["Distributed Systems", "Architecture"],
    cover: "",
    excerpt: "Exploring common patterns for building fault-tolerant distributed systems, from circuit breakers to saga orchestration.",
    lang: "en",
  },
  {
    slug: "arquitectura-hexagonal",
    title: "Arquitectura Hexagonal en Servicios IAM",
    date: "2026-04-20",
    tags: ["Arquitectura", "IAM", "Python"],
    cover: "",
    excerpt: "Cómo aplicar arquitectura hexagonal para construir servicios de identidad mantenibles y testeables.",
    lang: "es",
  },
];

const PLACEHOLDER_CONTENT = `
<p class="mb-4 leading-relaxed">This is placeholder content. Connect a Notion database with NOTION_TOKEN and NOTION_DATABASE_ID environment variables to publish real posts.</p>
<p class="mb-4 leading-relaxed">El contenido real se cargará desde Notion cuando las variables de entorno estén configuradas.</p>
`;

let notionClient: Client | null = null;

function getClient(): Client | null {
  if (notionClient) return notionClient;
  if (!process.env.NOTION_TOKEN) return null;
  notionClient = new Client({ auth: process.env.NOTION_TOKEN });
  return notionClient;
}

export async function getPosts(): Promise<BlogPostPreview[]> {
  const client = getClient();
  const dbId = process.env.NOTION_DATABASE_ID;

  if (!client || !dbId) return PLACEHOLDER_POSTS;

  try {
    const response = await client.databases.query({
      database_id: dbId,
      filter: {
        property: "Estado",
        select: { equals: "Published" },
      },
      sorts: [{ property: "Fecha", direction: "descending" }],
    });

    if (!response.results.length) return PLACEHOLDER_POSTS;

    const posts: BlogPostPreview[] = [];

    for (const page of response.results) {
      const preview = extractPreviewFromApi(page as Record<string, unknown>);
      if (preview && preview.slug && preview.title) {
        posts.push(preview);
      }
    }

    return posts.length ? posts : PLACEHOLDER_POSTS;
  } catch {
    return PLACEHOLDER_POSTS;
  }
}

export async function getPostBySlug(slug: string): Promise<BlogPost | null> {
  const client = getClient();
  const dbId = process.env.NOTION_DATABASE_ID;

  if (!client || !dbId) {
    const placeholder = PLACEHOLDER_POSTS.find((p) => p.slug === slug);
    if (!placeholder) return null;
    return { ...placeholder, content: PLACEHOLDER_CONTENT };
  }

  try {
    const response = await client.databases.query({
      database_id: dbId,
      filter: {
        and: [
          { property: "Estado", select: { equals: "Published" } },
          { property: "Slug", rich_text: { equals: slug } },
        ],
      },
    });

    if (!response.results.length) {
      const placeholder = PLACEHOLDER_POSTS.find((p) => p.slug === slug);
      if (!placeholder) return null;
      return { ...placeholder, content: PLACEHOLDER_CONTENT };
    }

    const page = response.results[0] as NotionPage;
    const preview = extractPreview(page);

    const blocks: Record<string, unknown>[] = [];
    let cursor: string | undefined;

    do {
      const list = await client.blocks.children.list({
        block_id: page.id,
        start_cursor: cursor,
      });
      blocks.push(...list.results);
      cursor = list.next_cursor ?? undefined;
    } while (cursor);

    const content = renderBlocks(blocks as Parameters<typeof renderBlocks>[0]);

    return { ...preview, content };
  } catch {
    const placeholder = PLACEHOLDER_POSTS.find((p) => p.slug === slug);
    if (!placeholder) return null;
    return { ...placeholder, content: PLACEHOLDER_CONTENT };
  }
}
