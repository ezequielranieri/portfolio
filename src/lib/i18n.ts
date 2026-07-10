export const LOCALES = ["en", "es"] as const;
export type Locale = (typeof LOCALES)[number];

export const translations = {
  en: {
    hero: {
      subtitle: "// backend & security engineer",
      bio: "I design and build secure, scalable, production-grade backend systems — combining strong architectural thinking with modern workflows to deliver reliable solutions with speed and precision. My focus: Identity & Access Management, distributed systems, and security engineering.",
      ctaProjects: "projects",
      ctaBlog: "blog",
    },
    nav: {
      home: "Home",
      projects: "Projects",
      blog: "Blog",
      contact: "Contact",
    },
    sections: {
      projectsTitle: "// projects",
      projectsPlaceholder: "Coming soon.",
      blogTitle: "// blog",
      blogPlaceholder: "Coming soon.",
    },
    contact: {
      contactTitle: "// contact",
      contactPlaceholder: "Links de contacto reales (GitHub, LinkedIn, email) pendientes de que Ezequiel los provea.",
    },
  },
  es: {
    hero: {
      subtitle: "// backend & security engineer",
      bio: "Diseño y construyo sistemas backend seguros y escalables, listos para producción. Combino pensamiento arquitectónico sólido con flujos de trabajo modernos para entregar soluciones confiables con velocidad y precisión. Mi foco: gestión de identidad y accesos (IAM), sistemas distribuidos, e ingeniería de seguridad.",
      ctaProjects: "proyectos",
      ctaBlog: "blog",
    },
    nav: {
      home: "Home",
      projects: "Proyectos",
      blog: "Blog",
      contact: "Contacto",
    },
    sections: {
      projectsTitle: "// proyectos",
      projectsPlaceholder: "Próximamente.",
      blogTitle: "// blog",
      blogPlaceholder: "Próximamente.",
    },
    contact: {
      contactTitle: "// contacto",
      contactPlaceholder: "Links de contacto reales (GitHub, LinkedIn, email) pendientes de que Ezequiel los provea.",
    },
  },
} as const;

export type TranslationKey = keyof typeof translations.en;

export function t(locale: Locale): (typeof translations)[Locale] {
  return translations[locale];
}
