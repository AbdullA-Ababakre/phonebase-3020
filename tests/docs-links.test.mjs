import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Mintlify keeps documentation navigation separate from the actual console", async () => {
  const overview = await read("docs/mintlify/overview.mdx");
  const quickstart = await read("docs/mintlify/quickstart.mdx");
  assert.ok(overview.includes("[Browser guide](/console)"));
  assert.ok(overview.includes("[Build with the REST API](/quickstart?path=api)"));
  assert.ok(quickstart.includes("[Cloud Console](https://phonebase.co/console)"));
  assert.ok(quickstart.includes("[browser control guide](/console)"));
});

test("all generated guides resolve internal documentation links and use current public domains", async () => {
  const pages = JSON.parse(await read("content/docs/pages.json"));
  const slugs = new Set(pages.map(page => page.slug));
  for (const page of pages) {
    for (const path of [`public/docs/${page.slug}.md`, `docs/mintlify/${page.slug}.mdx`]) {
      const source = await read(path);
      assert.doesNotMatch(source, /phonebase-station\.videocoding\.ai|phonebase-cloud-beta\.[\w.]+\.site/, path);
      for (const [, href] of source.matchAll(/\]\((\/[^)]+)\)/g)) {
        const pathname = new URL(href, "https://phonebase.co").pathname;
        if (pathname.startsWith("/docs/")) assert.ok(slugs.has(pathname.slice(6).replace(/\.md$/, "")), `${path}: ${href}`);
        else if (path.endsWith(".mdx")) assert.ok(slugs.has(pathname.slice(1)), `${path}: ${href}`);
      }
    }
  }
});
