import jsQR from 'jsqr';
import { useEffect, useRef, useState, type FormEvent } from 'react';

type CameraState = 'starting' | 'on' | 'unavailable' | 'denied';

/**
 * Lector de códigos: cámara del dispositivo y, debajo, una casilla para
 * teclear el código o usar un lector USB (que escribe como un teclado).
 */
export function Scanner(props: { onCode: (code: string) => void; busy?: boolean; hint?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(props.onCode);
  onCodeRef.current = props.onCode;
  const [camera, setCamera] = useState<CameraState>('starting');
  const [manual, setManual] = useState('');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let cancelled = false;
    let last = { code: '', at: 0 };
    const canvas = document.createElement('canvas');

    const scan = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) return;
      // Se analiza una copia reducida del fotograma: más rápido y suficiente para un QR.
      const scale = Math.min(1, 640 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hit = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
      const code = hit?.data.trim();
      if (!code) return;
      // El mismo código no se vuelve a enviar hasta pasados tres segundos.
      const now = Date.now();
      if (code === last.code && now - last.at < 3000) return;
      last = { code, at: now };
      navigator.vibrate?.(60);
      onCodeRef.current(code);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamera('unavailable');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        setCamera('on');
        timer = window.setInterval(scan, 180);
      } catch (e) {
        setCamera((e as DOMException)?.name === 'NotAllowedError' ? 'denied' : 'unavailable');
      }
    })();

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = manual.trim();
    if (!code) return;
    setManual('');
    props.onCode(code);
  };

  return (
    <div className="scanner">
      <div className={`scanner-view scanner-${camera}`}>
        <video ref={videoRef} playsInline muted />
        {camera === 'on' && <div className="scanner-frame" aria-hidden="true" />}
        {camera === 'starting' && <p>Activando la cámara…</p>}
        {camera === 'denied' && (
          <p>
            No hay permiso para usar la cámara. Actívalo en los ajustes del navegador, o escribe el código abajo.
          </p>
        )}
        {camera === 'unavailable' && (
          <p>
            La cámara no está disponible en este dispositivo o esta conexión. Escribe el código abajo o usa un lector
            USB.
          </p>
        )}
      </div>
      {props.hint && <p className="scanner-hint">{props.hint}</p>}

      <form className="inline" onSubmit={submit}>
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="Código: PAL-000125"
          aria-label="Código"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={camera === 'unavailable'}
        />
        <button className="btn btn-primary" disabled={props.busy || !manual.trim()}>
          Buscar
        </button>
      </form>
    </div>
  );
}
