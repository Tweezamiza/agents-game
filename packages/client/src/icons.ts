/**
 * DOM helpers for the inline SVG icon sprite defined in index.html.
 * Every protocol ItemId / StructureKind has a matching `#i-<id>` symbol.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Create an <svg class="icon"><use href="#i-…"/></svg> element. */
export function iconEl(symbolId: string, label?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("icon");
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${symbolId}`);
  svg.appendChild(use);
  return svg;
}

/** "ember_crystal" → "ember crystal" for tooltips and labels. */
export function itemLabel(id: string): string {
  return id.replace(/_/g, " ");
}
