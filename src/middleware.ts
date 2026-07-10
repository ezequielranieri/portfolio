import { defineMiddleware } from "astro:middleware";

const SUPPORTED = ["en", "es"];
const DEFAULT = "es";
const COOKIE = "locale";

function pick(acceptLanguage: string | null): string {
  if (!acceptLanguage) return DEFAULT;
  for (const entry of acceptLanguage.split(",")) {
    const raw = entry.split(";")[0].trim().split("-")[0];
    if (SUPPORTED.includes(raw)) return raw;
  }
  return DEFAULT;
}

export const onRequest = defineMiddleware((ctx, next) => {
  const { url, cookies, request } = ctx;
  const [_, first] = url.pathname.split("/");

  // Already on a locale-prefixed route → pass through
  if (first && SUPPORTED.includes(first)) return next();

  // Skip non-page requests (assets, etc.)
  if (first || url.pathname !== "/") return next();

  // Cookie check
  const stored = cookies.get(COOKIE)?.value;
  if (stored && SUPPORTED.includes(stored)) {
    return ctx.redirect(`/${stored}/`);
  }

  // Detect from Accept-Language
  const locale = pick(request.headers.get("accept-language"));
  cookies.set(COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  return ctx.redirect(`/${locale}/`);
});
