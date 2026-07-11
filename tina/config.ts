import { defineConfig } from "tinacms";

export default defineConfig({
  branch: process.env.VERCEL_GIT_COMMIT_REF || process.env.HEAD || "main",
  clientId: process.env.NEXT_PUBLIC_TINA_CLIENT_ID || "",
  token: process.env.TINA_TOKEN || "",
  build: {
    outputFolder: "admin",
    publicFolder: "public",
  },
  media: {
    tina: {
      mediaRoot: "uploads",
      publicFolder: "public",
    },
  },
  schema: {
    collections: [
      {
        name: "post",
        label: "Posts",
        path: "content/posts",
        format: "md",
        ui: {
          filename: {
            readonly: true,
            slugify: (values) => values?.slug || "",
          },
        },
        fields: [
          {
            type: "string",
            name: "title",
            label: "Title",
            isTitle: true,
            required: true,
          },
          {
            type: "string",
            name: "slug",
            label: "Slug",
            required: true,
          },
          {
            type: "string",
            name: "project",
            label: "Related Project",
            options: [
              "go-iam-service",
              "hex-auth-service",
              "high-performance-task-queue",
              "async-etl-framework",
            ],
          },
          {
            type: "string",
            name: "status",
            label: "Status",
            options: ["draft", "published"],
            required: true,
          },
          {
            type: "datetime",
            name: "date",
            label: "Date",
            required: true,
          },
          {
            type: "string",
            name: "lang",
            label: "Language",
            options: ["en", "es"],
            required: true,
          },
          {
            type: "string",
            name: "tags",
            label: "Tags",
            list: true,
          },
          {
            type: "string",
            name: "translationOf",
            label: "Translation of (slug)",
            description: "Slug del post hermano en el otro idioma",
          },
          {
            type: "image",
            name: "cover",
            label: "Cover Image",
          },
          {
            type: "rich-text",
            name: "body",
            label: "Body",
            isBody: true,
          },
        ],
      },
    ],
  },
});
