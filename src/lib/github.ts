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
      en: "High-performance IAM service with hexagonal architecture, O(1) token validation, refresh token rotation, rate limiting, and real-time security monitoring.",
      es: "Servicio IAM de alto rendimiento con arquitectura hexagonal, validación de tokens O(1), rotación de refresh tokens, rate limiting y monitoreo de seguridad en tiempo real.",
    },
    stack: ["Python", "FastAPI", "Redis"],
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
};

const DEFAULT_REPOS = Object.keys(MANUAL_OVERRIDES);

function placeholderProjects(): Project[] {
  return DEFAULT_REPOS.map((name) => {
    const o = MANUAL_OVERRIDES[name];
    return {
      name,
      description: o.description,
      stack: o.stack,
      repoUrl: `https://github.com/${name}`,
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
