export type Project = {
  name: string;
  description: { en: string; es: string };
  stack: string[];
  repoUrl: string;
  stars: number;
};

type Override = {
  description: { en: string; es: string };
  stack: string[];
};

const MANUAL_OVERRIDES: Record<string, Override> = {
  "hex-auth-service": {
    description: {
      en: "High-performance IAM solution with Hexagonal Architecture (Ports & Adapters). O(1) token validation via Redis, Refresh Token Rotation, and real-time breach detection.",
      es: "Solución IAM de alto rendimiento con arquitectura hexagonal (Ports & Adapters). Validación de tokens O(1) vía Redis, Refresh Token Rotation, y detección de breach en tiempo real.",
    },
    stack: ["Python", "FastAPI", "PostgreSQL", "Redis"],
  },
  "go-iam-service": {
    description: {
      en: "Performance-first authentication and identity service built as a modular monolith with Clean Architecture. Includes refresh token rotation with breach detection, Lua/Redis rate limiting, and full observability (Prometheus metrics, structured logging).",
      es: "Servicio de autenticación e identidad performance-first, construido como modular monolith con Clean Architecture. Incluye rotación de refresh tokens con detección de breach, rate limiting con Lua/Redis, y observabilidad completa (métricas Prometheus, structured logging).",
    },
    stack: ["Go", "PostgreSQL", "Redis", "JWT"],
  },
  "high-performance-task-queue": {
    description: {
      en: "Resilient async microservice for payments and critical operations, with strong idempotency and fault tolerance.",
      es: "Microservicio asíncrono resiliente para pagos y operaciones críticas, con idempotencia fuerte y tolerancia a fallos.",
    },
    stack: ["Python", "RabbitMQ", "PostgreSQL"],
  },
  "async-etl-framework": {
    description: {
      en: "Scalable async ETL framework built with Polars.",
      es: "Framework ETL asíncrono y escalable construido con Polars.",
    },
    stack: ["Python", "Polars"],
  },
  "flowcore": {
    description: {
      en: "Distributed, durable, and observable workflow engine. Supports the Saga pattern with automatic compensations, workflow versioning, multi-tenancy, and worker failure recovery.",
      es: "Motor de workflows distribuido, durable y observable. Soporta patrón Saga con compensaciones automáticas, versioning de workflows, multi-tenancy, y recuperación ante fallos de workers.",
    },
    stack: ["Python", "Celery", "RabbitMQ", "PostgreSQL"],
  },
};

const DEFAULT_REPOS = Object.keys(MANUAL_OVERRIDES);

function placeholderProjects(): Project[] {
  const user = process.env.GITHUB_USERNAME || "ezequielranieri";
  const featured = process.env.GITHUB_FEATURED_REPOS;
  let names = DEFAULT_REPOS;
  if (featured) {
    const filtered = featured.split(",").map((s) => s.trim());
    names = filtered.filter((n) => DEFAULT_REPOS.includes(n));
  }
  return names.map((name) => {
    const o = MANUAL_OVERRIDES[name];
    return {
      name,
      description: o.description,
      stack: o.stack,
      repoUrl: `https://github.com/${user}/${name}`,
      stars: 0,
    };
  });
}

async function fetchWithTimeout(url: string, options: RequestInit, ms = 4000): Promise<Response> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

export async function getProjects(): Promise<Project[]> {
  const username = process.env.GITHUB_USERNAME;

  if (!username) {
    return placeholderProjects();
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetchWithTimeout(
      `https://api.github.com/users/${username}/repos?per_page=100&sort=updated`,
      { headers }
    );

    if (!res.ok) {
      return placeholderProjects();
    }

    const repos = (await res.json()) as Array<{
      name: string;
      html_url: string;
      fork: boolean;
      private: boolean;
      stargazers_count: number;
      language: string | null;
      description: string | null;
    }>;

    const valid = repos.filter((r) => !r.fork && !r.private);

    const featured = process.env.GITHUB_FEATURED_REPOS;
    let selected: typeof valid;
    if (featured) {
      const names = featured.split(",").map((s) => s.trim());
      selected = names
        .map((n) => valid.find((r) => r.name === n))
        .filter((r): r is (typeof valid)[number] => r !== undefined);
      if (selected.length === 0) selected = valid.slice(0, 3);
    } else {
      selected = valid.sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, 3);
    }

    return selected.map((repo) => {
      const override = MANUAL_OVERRIDES[repo.name];
      return {
        name: repo.name,
        description: override
          ? override.description
          : { en: repo.description || "", es: repo.description || "" },
        stack: override ? override.stack : repo.language ? [repo.language] : [],
        repoUrl: repo.html_url,
        stars: repo.stargazers_count,
      };
    });
  } catch {
    return placeholderProjects();
  }
}
