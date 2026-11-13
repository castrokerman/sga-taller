import { useEffect, useState } from 'react';

/**
 * Navegación mínima basada en la parte de la dirección que va tras «#».
 * Así funcionan el botón «atrás» del móvil y los enlaces directos a una pantalla.
 */
export interface Route {
  name: string;
  id?: string;
}

function parse(): Route {
  const [name = '', id] = window.location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'inicio', id: id || undefined };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string): void {
  window.location.hash = `#/${path}`;
  window.scrollTo(0, 0);
}
