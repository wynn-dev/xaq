// XML parts of OOXML packages, parsed with @xmldom/xmldom in the parser child. A part with a DOCTYPE (or any entity
// declaration) is refused before parsing: Office never writes one, and it's how XXE and entity-expansion attacks
// start. xmldom itself doesn't fetch external entities or expand declared ones; refusing first means neither matters.

import { DOMParser, type Element, type Node } from "@xmldom/xmldom";
import { UnsafeDocumentError } from "./types.ts";

const ELEMENT = 1;
const TEXT = 3;
const CDATA = 4;

export function parseXml(source: string): Element {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    throw new UnsafeDocumentError("The document declares XML entities (a DOCTYPE), which Office files never do; it wasn't read.");
  }
  let failed: string | null = null;
  const doc = new DOMParser({
    onError: (level, msg) => {
      if (level !== "warning") failed ??= msg;
    },
  }).parseFromString(source, "text/xml");
  const root = doc.documentElement;
  if (failed || !root) throw new UnsafeDocumentError("The document has malformed XML.");
  return root;
}

export const local = (n: Node) => (n as Element).localName ?? n.nodeName.replace(/^.*:/, "");

export function* childElements(el: Node, name?: string): Generator<Element> {
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === ELEMENT && (!name || local(c) === name)) yield c as Element;
  }
}

export const firstChild = (el: Node, name: string): Element | null => childElements(el, name).next().value ?? null;

/** Descendants named `name`, in document order (iterative: deep nesting can't overflow the stack). */
export function* descendants(el: Node, name: string): Generator<Element> {
  const stack: Node[] = [];
  for (let c = el.lastChild; c; c = c.previousSibling) stack.push(c);
  while (stack.length) {
    const n = stack.pop()!;
    if (n.nodeType !== ELEMENT) continue;
    if (local(n) === name) yield n as Element;
    for (let c = n.lastChild; c; c = c.previousSibling) stack.push(c);
  }
}

/** An attribute by local name (w:val, r:id and val all match "val" / "id"). */
export function attr(el: Element, name: string): string | null {
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs.item(i)!;
    if ((a.localName ?? a.name.replace(/^.*:/, "")) === name) return a.value;
  }
  return null;
}

/** The r:id attribute (the relationships namespace), never a same-named id in another namespace. */
export function relId(el: Element): string | null {
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs.item(i)!;
    if ((a.localName ?? "") === "id" && (a.namespaceURI ?? "").endsWith("/relationships")) return a.value;
  }
  return null;
}

/** Concatenated text of the element's text and CDATA nodes. */
export function textOf(el: Node): string {
  let out = "";
  const stack: Node[] = [el];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.nodeType === TEXT || n.nodeType === CDATA) out += n.nodeValue ?? "";
    for (let c = n.lastChild; c; c = c.previousSibling) stack.push(c);
  }
  return out;
}

/** A package part's relationships: id → { target, external, type }. */
export function relationships(xml: string | null): Map<string, { target: string; external: boolean; type: string }> {
  const out = new Map<string, { target: string; external: boolean; type: string }>();
  if (!xml) return out;
  for (const r of childElements(parseXml(xml), "Relationship")) {
    const id = attr(r, "Id");
    const target = attr(r, "Target");
    if (id && target) out.set(id, { target, external: attr(r, "TargetMode") === "External", type: attr(r, "Type") ?? "" });
  }
  return out;
}

/** "word/document.xml" → "word/_rels/document.xml.rels". */
export const relsPath = (part: string) => {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
};
