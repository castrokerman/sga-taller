/** Configuración de la API, leída de variables de entorno. */
export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  /** Las cookies solo viajan por HTTPS. Desactivar únicamente en pruebas. */
  cookieSecure: boolean;
  cookieName: string;
  /** Primer administrador, creado al arrancar si no existe ningún usuario. */
  adminUsername?: string;
  adminPassword?: string;
  /** Carga usuarios ficticios de demostración al arrancar. */
  seedDemo: boolean;
  logLevel: string;
  /** Intentos de inicio de sesión permitidos por minuto y dirección IP. */
  loginRateLimit: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export function loadConfig(): Config {
  return {
    databaseUrl: required('DATABASE_URL'),
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '0.0.0.0',
    cookieSecure: (process.env.COOKIE_SECURE ?? 'true') !== 'false',
    cookieName: process.env.COOKIE_NAME ?? 'sga_session',
    adminUsername: process.env.ADMIN_USERNAME || undefined,
    adminPassword: process.env.ADMIN_PASSWORD || undefined,
    seedDemo: process.env.SEED_DEMO === 'true',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    loginRateLimit: Number(process.env.LOGIN_RATE_LIMIT ?? 10),
  };
}
