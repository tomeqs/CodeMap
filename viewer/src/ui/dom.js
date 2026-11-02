/** Tiny hyperscript helper: h('div', { class: 'x', onClick }, child, 'text'). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'checked' || key === 'value' || key === 'selected' || key === 'disabled') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }

  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }

  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function fmt(value) {
  if (value === undefined || value === null || Number.isNaN(value)) return '–';
  if (Math.abs(value) >= 10000) return (value / 1000).toFixed(value >= 100000 ? 0 : 1) + 'k';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(value < 1 ? 2 : 1);
}

export function shortName(node) {
  if (!node) return '';
  if (node.kind === 'namespace') return node.name;
  if (node.level === 'member') {
    // Qualified with its class (C# type, TypeScript class); a function or a class of a file stands on its own.
    const owner = node.ownerNode && node.ownerNode !== node ? node.ownerNode.name : null;
    return owner ? `${owner}.${node.name}` : node.name;
  }

  return node.name;
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
