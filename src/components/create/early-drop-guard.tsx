/**
 * Shared contract between the inline pre-hydration guard (below) and <FileDropzone>.
 *
 * Before React hydrates, the server-rendered upload area has no event handlers, so a file
 * dropped on the page would make the browser open the file and abandon the form. This tiny
 * inline script runs as soon as the HTML arrives and, until the dropzone reports ready:
 *  - prevents the browser's default "open the dropped file" behavior anywhere on the page;
 *  - holds files dropped onto the upload area so the dropzone can process them (with the
 *    normal validation and file limit) once it hydrates — nothing is silently discarded.
 *
 * It listens on `window` in the capture phase because React stops propagation of events
 * that target a still-hydrating part of the page (to replay them later); a bubbling
 * listener on `document` would miss drops made while hydration is in progress.
 */

export const DROPZONE_ATTRIBUTE = "data-upload-dropzone";

export type EarlyDropBuffer = {
  /** Files dropped on the upload area before hydration. */
  files: File[];
  /** Set to false by the hydrated dropzone; the guard then stops intercepting. */
  active: boolean;
};

declare global {
  interface Window {
    __teachmateEarlyDrop?: EarlyDropBuffer;
  }
}

const GUARD_SCRIPT = `(function () {
  if (window.__teachmateEarlyDrop) return;
  var buffer = (window.__teachmateEarlyDrop = { files: [], active: true });
  function hasFiles(event) {
    var types = event.dataTransfer && event.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, "Files") !== -1;
  }
  function intercept(event) {
    if (!buffer.active || !hasFiles(event)) return;
    if (event.type !== "dragleave") event.preventDefault();
    var target = event.target;
    var zone = target && target.closest ? target.closest("[${DROPZONE_ATTRIBUTE}]") : null;
    if (!zone) return;
    // Own drags over the not-yet-ready upload area entirely, so React's hydration
    // event replay cannot also deliver them (which would add files twice or leave
    // the drag highlight stuck).
    event.stopPropagation();
    if (event.type !== "drop") return;
    var files = event.dataTransfer.files;
    for (var i = 0; i < files.length; i++) buffer.files.push(files[i]);
  }
  // Window + capture phase: runs before React's root listeners, which stop propagation
  // of events aimed at parts of the page that are still hydrating.
  ["dragenter", "dragover", "dragleave", "drop"].forEach(function (type) {
    window.addEventListener(type, intercept, true);
  });
})();`;

/** Render once, before the upload area, in a Server Component (it must ship in the initial HTML). */
export function EarlyDropGuard() {
  return <script dangerouslySetInnerHTML={{ __html: GUARD_SCRIPT }} />;
}
