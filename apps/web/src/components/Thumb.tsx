import { useEffect, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { photoUrl } from '../api';

const canHover = () => typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches;

/**
 * Miniatura de una foto. Al pasar el cursor por encima se ve en grande al lado;
 * al pulsarla (o tocarla en el móvil) se abre ampliada sobre la página. En
 * ningún caso navega: para ver qué es no hace falta abrir la ficha.
 */
export function Thumb(props: { photoId: string; className?: string; alt?: string }) {
  const [hover, setHover] = useState<{ x: number; y: number; left: boolean } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const show = (e: MouseEvent<HTMLImageElement>) => {
    if (!canHover() || open) return;
    const r = e.currentTarget.getBoundingClientRect();
    const size = 300;
    const left = r.right + 12 + size > window.innerWidth;
    const y = Math.min(Math.max(8, r.top + r.height / 2 - size / 2), window.innerHeight - size - 8);
    setHover({ x: left ? r.left - 12 - size : r.right + 12, y, left });
  };

  const click = (e: MouseEvent<HTMLImageElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setHover(null);
    setOpen(true);
  };

  return (
    <>
      <img
        className={`${props.className ?? ''} thumb-zoom`}
        src={photoUrl(props.photoId)}
        alt={props.alt ?? ''}
        loading="lazy"
        onMouseEnter={show}
        onMouseLeave={() => setHover(null)}
        onClick={click}
        title="Pulsa para ampliar"
      />
      {hover &&
        createPortal(
          <div className="thumb-preview" style={{ left: hover.x, top: hover.y }} aria-hidden="true">
            <img src={photoUrl(props.photoId, 'image')} alt="" />
          </div>,
          document.body,
        )}
      {open &&
        createPortal(
          <div
            className="thumb-lightbox"
            role="dialog"
            aria-label="Foto ampliada"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          >
            <img src={photoUrl(props.photoId, 'image')} alt={props.alt ?? ''} />
            <button type="button" className="thumb-close" aria-label="Cerrar">
              ✕
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
