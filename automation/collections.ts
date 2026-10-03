/** Observable repeated link structure, without site names, classes, IDs or titles. */
import type { LinkPattern } from "./schema.js";

export interface LinkCollection {
  key: string;
  pattern: LinkPattern;
  count: number;
  kind: string;
  samples: { text: string; href: string }[];
}

/** Runs inside the page. Keep all browser-side helpers inside this function. */
export function observeLinkCollections(): LinkCollection[] {
  const groups = new Map<string, { pattern: LinkPattern; kind: string; links: HTMLAnchorElement[] }>();
  const visible = (el: HTMLElement) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== "hidden" && !el.closest('[aria-hidden="true"],nav,header,footer,form,[role="navigation"],[role="banner"],[role="contentinfo"]');
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (!visible(link) || !link.innerText.trim() || !/^https?:$/.test(new URL(link.href).protocol)) continue;
    let root = link.closest<HTMLElement>('tr,li,article,h1,h2,h3,h4,h5,h6,[role="row"],[role="listitem"]');
    // Generic cards: use an ancestor repeated among siblings with the same
    // native child shape. Collection samples let the model choose the right group.
    if (!root) for (let parent = link.parentElement, depth = 0; parent && depth < 5; parent = parent.parentElement, depth++) {
      if (["BODY", "HTML", "MAIN", "NAV", "HEADER", "FOOTER"].includes(parent.tagName)) break;
      const shape = Array.from(parent.children).map((c) => c.tagName).join(",");
      if (parent.parentElement && Array.from(parent.parentElement.children).filter((s) => s.tagName === parent.tagName && Array.from(s.children).map((c) => c.tagName).join(",") === shape).length >= 2) { root = parent; break; }
    }
    if (!root || root === link || !visible(root)) continue;
    const path: LinkPattern["path"] = [];
    let node: Element | null = link;
    while (node && node !== root && path.length <= 10) {
      const siblings: Element[] = Array.from(node.parentElement?.children ?? []).filter((s) => s.tagName === node!.tagName);
      path.unshift({ tag: node.tagName.toLowerCase(), index: siblings.indexOf(node) + 1 });
      node = node.parentElement;
    }
    if (node !== root || !path.length || path.length > 10 || root.children.length > 40) continue;
    const ranked = root.tagName === "TR" && /^\d+\s*[.)]?$/.test((root.firstElementChild as HTMLElement | null)?.innerText.trim() ?? "");
    const pattern: LinkPattern = { rootTag: root.tagName.toLowerCase(), childTags: Array.from(root.children).map((c) => c.tagName.toLowerCase()), ranked, path };
    const key = JSON.stringify(pattern);
    const group = groups.get(key) ?? { pattern, kind: ranked ? "ranked row links" : `links in repeated ${root.tagName.toLowerCase()} elements`, links: [] };
    group.links.push(link);
    groups.set(key, group);
  }
  return Array.from(groups.values()).filter((g) => g.links.length >= 2)
    .sort((a, b) => Number(b.pattern.ranked) - Number(a.pattern.ranked) || b.links.length - a.links.length)
    .slice(0, 30).map((g, i) => ({ key: `links_${i + 1}`, pattern: g.pattern, kind: g.kind, count: g.links.length,
      samples: g.links.slice(0, 3).map((a) => ({ text: a.innerText.trim().slice(0, 180), href: a.href })) }));
}

/** The descriptor is schema-validated before it reaches this native XPath. */
export function linkPatternXPath(p: LinkPattern): string {
  const shape = [`count(*)=${p.childTags.length}`, ...p.childTags.map((tag, i) => `*[${i + 1}][self::${tag}]`)];
  // Numeric ranks distinguish article rows from the same-shaped layout/header rows.
  if (p.ranked) shape.push("string-length(translate(normalize-space(*[1]), '0123456789.) ', ''))=0", "string-length(normalize-space(*[1]))>0");
  return `.//${p.rootTag}[${shape.join(" and ")}]` + p.path.map((step) => `/${step.tag}[${step.index}]`).join("");
}
