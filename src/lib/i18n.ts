export const LOCALES = ["en", "es"] as const;
export type Locale = (typeof LOCALES)[number];

export const translations = {
  en: {
    hero: {
      subtitle: "// backend engineer | AI-Fluent",
      tagline: "IAM • distributed systems • security",
      bio: "I design and build secure, scalable, production-grade backend systems — combining strong architectural thinking with modern AI-assisted workflows to deliver high-quality solutions with speed and precision. My focus: Identity & Access Management, distributed systems, and security engineering.",
      ctaProjects: "projects",
      ctaBlog: "blog",
      badgeLabel: "LFD121 Developing Secure Software — view credential",
      badgeLabel2: "LFEL1012 Secure AI/ML-Driven Software Development — view credential",
      badgeCaption: "Linux Foundation · 2026",
    },
    aboutMe: {
      title: "// about me",
      paragraphs: [
        "I'm Ezequiel, a self-taught backend engineer from Salto Grande, Santa Fe, Argentina.",
        "I started coding to help friends with real needs. Over time I realized what really hooked me was backend systems and security: understanding how solid systems are built, how they are protected, and how they fail.",
        "I learned on my own. No formal degree, but a lot of curiosity, practice, and a strong need to understand the “why” behind every decision. That led me to become obsessed with clean architecture, well-organized code, and security by design.",
        "Today I focus on Identity & Access Management, multi-tenant systems, and resilient architectures — combining backend with artificial intelligence. I like building things that can actually be used, and documenting the reasoning behind every choice.",
        "I’m still learning every day. And that’s what I enjoy most about this path.",
      ],
    },
    nav: {
      home: "Home",
      projects: "Projects",
      blog: "Blog",
      howIWork: "How I Work",
      certifications: "Certifications",
      contact: "Contact",
    },
    howIWork: {
      title: "// how i work",
      intro: "I integrate modern AI tools (OpenCode, Cursor, Claude) to accelerate development, keeping full ownership of architecture, security, and code quality. Strong fundamentals first, AI as a force multiplier.",
      principles: [
        {
          title: "Explicit over implicit",
          body: "Every guarantee — idempotency, retries, failure handling — is designed up front and documented in DECISIONS.md. No \"we'll see in production.\"",
        },
        {
          title: "Tests are the contract",
          body: "I write tests first, run them with -race, and treat a green suite as the definition of done. The domain stays free of infrastructure details.",
        },
        {
          title: "AI-accelerated development",
          body: "I integrate AI tools to multiply performance: scaffolding, test generation, code review passes, and research on edge cases. Architecture decisions and final review stay human. AI speed multiplies rigor; it never replaces it.",
        },
        {
          title: "No premature infrastructure",
          body: "I use the simplest tool that provides the right guarantee — Postgres before a broker, a clean state machine before a workflow engine. Complexity earns its place.",
        },
      ],
    },
    sections: {
      projectsTitle: "// projects",
      projectsPlaceholder: "Coming soon.",
      blogTitle: "// blog",
      blogPlaceholder: "Coming soon.",
    },
    blog: {
      back: "← back",
      readTranslation: "Read in Spanish →",
    },
    certifications: {
      title: "// certifications",
      verify: "verify →",
    },
    contact: {
      contactTitle: "// contact",
      email: "Email",
    },
  },
  es: {
    hero: {
      subtitle: "// ingeniero backend | AI-Fluent",
      tagline: "IAM • sistemas distribuidos • seguridad",
      bio: "Diseño y construyo sistemas backend seguros y escalables, listos para producción. Combino pensamiento arquitectónico sólido con flujos de trabajo asistidos por IA para entregar soluciones de alta calidad con velocidad y precisión. Mi foco: gestión de identidad y accesos (IAM), sistemas distribuidos, e ingeniería de seguridad.",
      ctaProjects: "proyectos",
      ctaBlog: "blog",
      badgeLabel: "LFD121 Developing Secure Software — ver credencial",
      badgeLabel2: "LFEL1012 Secure AI/ML-Driven Software Development — ver credencial",
      badgeCaption: "Linux Foundation · 2026",
    },
    aboutMe: {
      title: "// sobre mí",
      paragraphs: [
        "Soy Ezequiel, ingeniero backend autodidacta de Salto Grande, Santa Fe, Argentina.",
        "Empecé programando para ayudar a amigos con necesidades reales. Con el tiempo me di cuenta de que lo que más me atrapaba era el backend y la seguridad: entender cómo se construyen sistemas sólidos, cómo se protegen y cómo fallan.",
        "Aprendí por mi cuenta. Sin carrera formal, pero con mucha curiosidad, práctica y ganas de entender el “por qué” detrás de cada decisión. Eso me llevó a obsesionarme con la arquitectura limpia, la organización del código y la seguridad desde el diseño.",
        "Hoy me enfoco en Identity & Access Management, sistemas multi-tenant y arquitecturas resilientes, combinando backend con inteligencia artificial. Me gusta construir cosas que puedan usarse de verdad y documentar el razonamiento detrás de cada elección.",
        "Sigo aprendiendo todos los días. Y eso es lo que más me gusta de este camino.",
      ],
    },
    nav: {
      home: "Home",
      projects: "Proyectos",
      blog: "Blog",
      howIWork: "Cómo Trabajo",
      certifications: "Certificaciones",
      contact: "Contacto",
    },
    howIWork: {
      title: "// cómo trabajo",
      intro: "Integro herramientas modernas de IA (OpenCode, Cursor, Claude) para acelerar el desarrollo, manteniendo total responsabilidad sobre la arquitectura, la seguridad y la calidad del código. Fundamentos sólidos primero, IA como multiplicador de fuerza.",
      principles: [
        {
          title: "Explícito sobre implícito",
          body: "Cada garantía —idempotencia, retries, manejo de fallos— se diseña de antemano y se documenta en DECISIONS.md. Nada de \"ya veremos en producción\".",
        },
        {
          title: "Los tests son el contrato",
          body: "Escribo tests primero, los corro con -race y trato una suite en verde como definición de listo. El dominio queda libre de detalles de infraestructura.",
        },
        {
          title: "Desarrollo acelerado con IA",
          body: "Integro herramientas de IA para multiplicar el rendimiento: scaffolding, generación de tests, pasadas de code review e investigación de edge cases. Las decisiones de arquitectura y la revisión final siguen siendo humanas. La velocidad de la IA multiplica el rigor; nunca lo reemplaza.",
        },
        {
          title: "Sin infraestructura prematura",
          body: "Uso la herramienta más simple que dé la garantía correcta — Postgres antes que un broker, una state machine limpia antes que un workflow engine. La complejidad se gana su lugar.",
        },
      ],
    },
    sections: {
      projectsTitle: "// proyectos",
      projectsPlaceholder: "Próximamente.",
      blogTitle: "// blog",
      blogPlaceholder: "Próximamente.",
    },
    blog: {
      back: "← volver",
      readTranslation: "Leer en inglés →",
    },
    certifications: {
      title: "// certificaciones",
      verify: "verificar →",
    },
    contact: {
      contactTitle: "// contacto",
      email: "Email",
    },
  },
} as const;

export type TranslationKey = keyof typeof translations.en;

export function t(locale: Locale): (typeof translations)[Locale] {
  return translations[locale];
}
