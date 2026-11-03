/** Minimal DOM helpers - no framework, no innerHTML for dynamic content. */

const trackedDocuments = new WeakSet<Document>();
const composingInputs = new WeakSet<EventTarget>();
const deferredRenders = new WeakMap<EventTarget, () => void>();

function trackComposition(document: Document): void {
  if (trackedDocuments.has(document) || typeof document.addEventListener !== 'function') return;
  trackedDocuments.add(document);
  document.addEventListener('compositionstart', (event) => {
    if (event.target) composingInputs.add(event.target);
  }, true);
  document.addEventListener('compositionend', (event) => {
    const target = event.target;
    if (!target) return;
    composingInputs.delete(target);
    // A final input event may follow compositionend and render a newer state.
    queueMicrotask(() => {
      const render = deferredRenders.get(target);
      deferredRenders.delete(target);
      render?.();
    });
  }, true);
}

/** Keep a text editor, its caret and IME composition stable during live re-renders. */
export function preserveInputFocus(container: HTMLElement, render: () => void): void {
  const document = container.ownerDocument ?? globalThis.document;
  if (document) trackComposition(document);
  const active = document?.activeElement as HTMLInputElement | HTMLTextAreaElement | null | undefined;
  if (!active || typeof container.contains !== 'function' || !container.contains(active) ||
      !['INPUT', 'TEXTAREA'].includes(active.tagName) || !active.matches('input:not([type=checkbox]):not([type=radio]), textarea')) {
    render();
    return;
  }
  if (composingInputs.has(active)) {
    // Replacing a composing input would cancel the user's in-progress IME text.
    deferredRenders.set(active, () => {
      if (container.contains(active)) preserveInputFocus(container, render);
    });
    return;
  }
  deferredRenders.delete(active);
  const id = active.id;
  const name = active.getAttribute('name');
  if (!id && !name) { render(); return; }
  const tag = active.tagName;
  const type = active.getAttribute('type');
  const start = active.selectionStart;
  const end = active.selectionEnd;
  const direction = active.selectionDirection ?? undefined;
  const scrollLeft = active.scrollLeft;
  const value = active.value;
  render();
  const next = Array.from(container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'))
    .find((element) => element.tagName === tag && element.getAttribute('type') === type &&
      (id ? element.id === id : element.getAttribute('name') === name));
  if (!next || next.disabled) return;
  // A storage response may normalize an incomplete value (e.g. an unfinished
  // hostname or trailing space). Do not overwrite what is actively being typed.
  if (next.value !== value && next.type !== 'file') {
    const confirmedValue = next.value;
    next.value = value;
    next.addEventListener('blur', () => queueMicrotask(() => {
      if (next.isConnected && document.activeElement !== next) next.value = confirmedValue;
    }), { once: true });
  }
  next.focus({ preventScroll: true });
  if (start !== null && end !== null) {
    try { next.setSelectionRange(start, end, direction); } catch { /* Some input types do not support a selection. */ }
  }
  next.scrollLeft = scrollLeft;
}

export type Child = Node | string | number | null | undefined | false | Child[];

export interface ElProps {
  class?: string;
  src?: string;
  alt?: string;
  loading?: string;
  hidden?: boolean;
  autocomplete?: string;
  spellcheck?: string;
  for?: string;
  inputmode?: string;
  list?: string;
  maxlength?: number | string;
  accept?: string;
  colspan?: number | string;
  onclick?: (event: Event) => void;
  oninput?: (event: Event) => void;
  onchange?: (event: Event) => void;
  onsubmit?: (event: Event) => void;
  onkeydown?: (event: Event) => void;
  onerror?: (event: Event) => void;
  onClick?: (event: Event) => void;
  onInput?: (event: Event) => void;
  onChange?: (event: Event) => void;
  onSubmit?: (event: Event) => void;
  onKeydown?: (event: Event) => void;
  onError?: (event: Event) => void;
  id?: string;
  text?: string;
  title?: string;
  type?: string;
  value?: string;
  name?: string;
  placeholder?: string;
  href?: string;
  target?: string;
  rel?: string;
  rows?: number;
  max?: number | string;
  min?: number | string;
  step?: number | string;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  style?: string;
  role?: string;
  ariaLabel?: string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Partial<Record<'click' | 'input' | 'change' | 'submit' | 'keydown' | 'error' | 'focus' | 'blur', (event: Event) => void>>;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: ElProps = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  const { on, dataset, attrs, class: className, text, ariaLabel, onClick, onInput, onChange, onSubmit, onKeydown, onError, ...rest } = props;
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  if (ariaLabel) element.setAttribute('aria-label', ariaLabel);
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || value === null) continue;
    if (key === 'checked' || key === 'disabled' || key === 'selected') {
      (element as unknown as Record<string, unknown>)[key] = value;
      continue;
    }
    if (key === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
      (element as HTMLInputElement).value = String(value);
      continue;
    }
    element.setAttribute(key, String(value));
  }
  if (dataset) for (const [key, value] of Object.entries(dataset)) element.dataset[key] = value;
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (on) {
    for (const [event, handler] of Object.entries(on)) {
      element.addEventListener(event, handler as EventListener);
    }
  }
  // Both `on: { click }` and the `onClick` shorthand are supported.
  const shorthand: Array<[string, ((event: Event) => void) | undefined]> = [
    ['click', onClick],
    ['input', onInput],
    ['change', onChange],
    ['submit', onSubmit],
    ['keydown', onKeydown],
    ['error', onError],
  ];
  for (const [event, handler] of shorthand) {
    if (handler) element.addEventListener(event, handler as EventListener);
  }
  append(element, children);
  return element;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, child);
      continue;
    }
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function fragment(...children: Child[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  append(frag, children);
  return frag;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS: Record<string, string> = {
  download: 'M12 3v12m0 0l-4-4m4 4l4-4M5 21h14',
  star: 'M12 4l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 10.2l5.9-.9z',
  trash: 'M4 7h16M9 7V4h6v3m-8 0l1 14h8l1-14',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  edit: 'M4 20h4L20 8l-4-4L4 16z',
  check: 'M5 13l4 4L19 7',
  alert: 'M12 4l9 16H3zM12 10v5M12 18h.01',
  refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4',
  plus: 'M12 5v14M5 12h14',
  play: 'M7 5l12 7-12 7z',
  pause: 'M8 5v14M16 5v14',
  close: 'M6 6l12 12M18 6L6 18',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.2 16.2l4.3 4.3',
  servers: 'M4 6h16M4 12h16M4 18h16',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4',
  queue: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  external: 'M14 5h5v5M19 5l-9 9M11 5H6v14h14v-5',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21c0-4 4-6 8-6s8 2 8 6',
  shield: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z',
  info: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 11v5M12 8h.01',
};

export function icon(name: keyof typeof ICON_PATHS | string, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICON_PATHS[name] ?? ICON_PATHS.info!);
  svg.appendChild(path);
  return svg;
}

export function button(
  label: string,
  options: ElProps & { iconName?: string; variant?: 'primary' | 'ghost' | 'danger' | 'subtle' } = {},
): HTMLButtonElement {
  const { iconName, variant, ...rest } = options;
  const children: Child[] = [];
  if (iconName) children.push(icon(iconName));
  if (label) children.push(h('span', { text: label }));
  return h(
    'button',
    { type: 'button', class: `btn ${variant ? `btn-${variant}` : ''}`.trim(), ...rest },
    ...children,
  );
}

export function field(
  label: string,
  control: HTMLElement,
  options: { help?: string; hint?: string; id?: string } = {},
): HTMLElement {
  return h(
    'label',
    { class: 'field', attrs: options.id ? { for: options.id } : undefined },
    h('span', { class: 'field-label', text: label, ...(options.hint ? { title: options.hint } : {}) }),
    control,
    options.help ? h('span', { class: 'field-help', text: options.help }) : null,
  );
}
