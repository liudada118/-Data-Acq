import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";

/** Long guidance and small-card settings live outside the card's height budget. */
export function MicrophoneDialog({ id, title, children, onClose }: {
  id: string;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return <dialog ref={dialog} id={id} className="modal microphone-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="modal-header">
      <h2 id={titleId}>{title}</h2>
      <button className="icon-button" aria-label="关闭麦克风窗口" onClick={onClose}><X size={18} /></button>
    </header>
    <div className="microphone-dialog-body">{children}</div>
  </dialog>;
}
