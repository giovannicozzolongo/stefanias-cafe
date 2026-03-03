export function img(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return `${base}${clean}`;
}
