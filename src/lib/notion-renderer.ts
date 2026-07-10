type RichText = {
  plain_text: string;
  annotations: { bold: boolean; italic: boolean; code: boolean; strikethrough: boolean; underline: boolean; color: string };
  href: string | null;
};

function renderRichText(richText: RichText[]): string {
  return richText
    .map((t) => {
      let text = t.plain_text;
      if (t.annotations.code) text = `<code class="font-mono text-xs px-1 py-0.5 bg-bg-raised border border-line rounded-none">${text}</code>`;
      if (t.annotations.bold) text = `<strong>${text}</strong>`;
      if (t.annotations.italic) text = `<em>${text}</em>`;
      if (t.annotations.strikethrough) text = `<del>${text}</del>`;
      if (t.href) text = `<a href="${t.href}" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 text-ink-dim hover:text-ink transition-colors duration-150">${text}</a>`;
      return text;
    })
    .join("");
}

type Block = {
  type: string;
  [key: string]: unknown;
};

export function renderBlocks(blocks: Block[]): string {
  const html: string[] = [];

  for (const block of blocks) {
    const { type } = block;
    const data = block[type] as { rich_text?: RichText[]; caption?: RichText[]; url?: string; language?: string } | undefined;

    if (!data) continue;

    switch (type) {
      case "paragraph": {
        const text = renderRichText(data.rich_text || []);
        if (text) html.push(`<p class="mb-4 leading-relaxed">${text}</p>`);
        break;
      }
      case "heading_1":
        html.push(`<h2 class="font-display text-2xl tracking-tight text-ink uppercase mt-10 mb-4">${renderRichText(data.rich_text || [])}</h2>`);
        break;
      case "heading_2":
        html.push(`<h3 class="font-display text-xl tracking-tight text-ink uppercase mt-8 mb-3">${renderRichText(data.rich_text || [])}</h3>`);
        break;
      case "heading_3":
        html.push(`<h4 class="font-display text-lg tracking-tight text-ink uppercase mt-6 mb-2">${renderRichText(data.rich_text || [])}</h4>`);
        break;
      case "bulleted_list_item":
        html.push(`<li class="ml-5 mb-1 text-ink-dim leading-relaxed list-disc">${renderRichText(data.rich_text || [])}</li>`);
        break;
      case "numbered_list_item":
        html.push(`<li class="ml-5 mb-1 text-ink-dim leading-relaxed list-decimal">${renderRichText(data.rich_text || [])}</li>`);
        break;
      case "code":
        html.push(`<pre class="bg-bg-raised border border-line p-4 mb-4 overflow-x-auto"><code class="font-mono text-sm leading-relaxed">${renderRichText(data.rich_text || [])}</code></pre>`);
        break;
      case "quote":
        html.push(`<blockquote class="border-l-2 border-ink-ghost pl-4 mb-4 text-ink-dim italic">${renderRichText(data.rich_text || [])}</blockquote>`);
        break;
      case "divider":
        html.push(`<hr class="border-line my-8" />`);
        break;
      case "to_do": {
        const checked = (data as Record<string, unknown>).checked as boolean;
        html.push(`<div class="flex items-start gap-2 mb-2"><span class="mt-0.5 shrink-0 w-4 h-4 border border-line flex items-center justify-center${checked ? ' bg-ink' : ''}">${checked ? '<svg class="w-3 h-3 text-bg" viewBox="0 0 12 12" fill="currentColor"><path d="M10.28 2.22a.75.75 0 010 1.06l-6 6a.75.75 0 01-1.06 0l-2.5-2.5a.75.75 0 011.06-1.06L3.75 7.69l5.47-5.47a.75.75 0 011.06 0z"/></svg>' : ''}</span><span class="text-ink-dim leading-relaxed">${renderRichText(data.rich_text || [])}</span></div>`);
        break;
      }
      case "callout":
        html.push(`<div class="bg-bg-raised border border-line p-4 mb-4 flex items-start gap-3"><span class="shrink-0 text-lg">${(data as Record<string, unknown>).icon as string || ''}</span><div class="text-ink-dim text-sm leading-relaxed">${renderRichText(data.rich_text || [])}</div></div>`);
        break;
      case "image": {
        const src = data.url || "";
        const alt = renderRichText(data.caption || []);
        html.push(`<figure class="my-6"><img src="${src}" alt="${alt}" class="w-full border border-line" loading="lazy" />${alt ? `<figcaption class="mt-2 text-xs font-mono text-ink-dim text-center">${alt}</figcaption>` : ''}</figure>`);
        break;
      }
    }
  }

  return html.join("\n");
}
