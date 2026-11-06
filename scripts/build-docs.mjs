import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const write = (path, text) => writeFileSync(resolve(root, path), text);
const pages = read("content/docs/pages.json");
const docsOrigin = "https://console.phonefarm.ai";
const remote = structuredClone(read("public/openapi.json"));
remote.info.title = "PhoneUse Remote Customer API";
remote.info.description =
  "Authenticated customer API for assigned physical devices on a PhoneUse station. Use the gateway and Bearer key from your invitation. The public docs host is not the API host.";
remote.servers = [
  {
    url: "https://{stationHost}",
    description: "Your assigned station gateway",
    variables: {
      stationHost: {
        default: "your-station.example",
        description: "Use the station hostname from your private invitation.",
      },
    },
  },
];
remote["x-phonebase-live-websocket"] = {
  url: "wss://{stationHost}/api/live/socket?deviceId={deviceId}&access_token={customerKey}&flow=latest&window=3",
  protocol:
    "JSON metadata followed by a binary image. Send frame_ready once, then acknowledge decoded sequences with frame_ack. Redact access_token from logs.",
};
remote["x-phonebase-security"] = {
  authentication:
    "Bearer customer key on every REST request. Customer assignment, validity, and origin restrictions are enforced by the gateway.",
  browser:
    "Exact allowed Origin is required when the request includes Origin. Non-browser clients may omit Origin.",
};
remote.security = [{ customerKey: [] }];
remote.components.securitySchemes = {
  customerKey: {
    type: "http",
    scheme: "bearer",
    description:
      "Decoded customer API key. Do not use the full pb_connect_v1 access code.",
  },
};
delete remote.paths["/api/v1/devices/{deviceId}/calibration"];
remote.tags = remote.tags
  .filter((tag) => tag.name !== "Setup")
  .map((tag) => ({
    ...tag,
    description: {
      Devices: "Assigned device discovery and readiness.",
      Observation: "Camera frames and observation metadata.",
      Actions: "Physical primitives and durable execution receipts.",
    }[tag.name],
  }));
delete remote.components.parameters.Actor;
remote.components.schemas.Action.oneOf =
  remote.components.schemas.Action.oneOf.filter(
    (item) => item.$ref !== "#/components/schemas/HomeAction",
  );
delete remote.components.schemas.HomeAction;
delete remote.components.schemas.CalibrationOperation;
delete remote.components.schemas.CalibrationResponse;
remote.components.schemas.RemoteError = {
  type: "object",
  required: ["ok", "error", "code"],
  properties: {
    ok: { const: false },
    error: { type: "string" },
    code: {
      type: "string",
      description: "Stable machine-readable error code.",
    },
  },
};
remote.components.responses.RemoteError = {
  description:
    "Request rejected by authentication, assignment, validation, readiness, or an upstream service.",
  headers: {
    "X-Phonebase-Error-Code": {
      description: "Stable machine-readable error code, also present in the JSON body.",
      schema: { type: "string" },
    },
    "X-Request-Id": {
      description: "Trace identifier for support and observability.",
      schema: { type: "string" },
    },
  },
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/RemoteError" },
    },
  },
};
remote.externalDocs = {
  url: `${docsOrigin}/docs/api-reference`,
  description: "Remote developer documentation",
};
for (const methods of Object.values(remote.paths))
  for (const [method, op] of Object.entries(methods)) {
    op.parameters = (op.parameters ?? []).filter(
      (p) => p.$ref !== "#/components/parameters/Actor",
    );
    for (const status of ["401", "403", "429", "502", "503"])
      op.responses[status] ??= { $ref: "#/components/responses/RemoteError" };
    if (method === "post") {
      op.responses["400"] ??= { $ref: "#/components/responses/RemoteError" };
      op.description =
        (op.description ?? "") +
        " Customer keys cannot perform mechanical Home. Read capabilities first and wait for the final action receipt.";
    }
  }
remote.paths["/health"].get.summary =
  "Check authenticated gateway connectivity";
remote.paths["/api/v1/devices"].get.summary = "List assigned devices";
write("public/openapi-remote.json", JSON.stringify(remote, null, 2) + "\n");
mkdirSync(resolve(root, "docs/mintlify"), { recursive: true });
mkdirSync(resolve(root, "public/docs"), { recursive: true });
function blockMarkdown(b) {
  switch (b.type) {
    case "text":
      return b.text;
    case "note":
      return "> " + b.text;
    case "code":
      return "```" + b.language + "\n" + b.value + "\n```";
    case "list":
      return b.items.map((i) => "- " + i).join("\n");
    case "cards":
      return b.items
        .map((i) => `- [${i.title}](${i.href}) — ${i.text}`)
        .join("\n");
    case "table":
      return [b.headers, b.headers.map(() => "---"), ...b.rows]
        .map((row) => "| " + row.join(" | ") + " |")
        .join("\n");
    case "api":
      return Object.entries(remote.paths)
        .flatMap(([path, ops]) =>
          Object.entries(ops).map(
            ([method, op]) =>
              `### ${method.toUpperCase()} \`${path}\`\n\n${op.summary}\n\n${op.description ?? ""}\n\nResponse statuses: ${Object.keys(op.responses).join(", ")}. See [remote OpenAPI](/openapi-remote.json) for full request and response schemas.`,
          ),
        )
        .join("\n\n");
    default:
      throw Error("Unknown block " + b.type);
  }
}
let full = "# PhoneUse documentation\n\n";
for (const page of pages) {
  const md =
    `# ${page.title}\n\n${page.description}\n\n` +
    page.sections
      .map(
        (s) => `## ${s.title}\n\n` + s.blocks.map(blockMarkdown).join("\n\n"),
      )
      .join("\n\n") +
    "\n";
  write(`public/docs/${page.slug}.md`, md);
  // Plain Markdown is valid MDX. Avoid raw placeholders being interpreted as JSX.
  write(
    `docs/mintlify/${page.slug}.mdx`,
    `---\ntitle: ${JSON.stringify(page.title)}\ndescription: ${JSON.stringify(page.description)}\n---\n\n` +
      md
        .replace(/^# .*\n\n/, "")
        .replace(/\]\((\/[^)]+)\)/g, (_, href) => {
          // Convert each original URL once: /docs/console is a guide, while
          // /console is the application. Preserve query strings and fragments.
          if (href.startsWith("/docs/")) return `](${href.slice(5)})`;
          if (href === "/docs") return "](/overview)";
          return `](${docsOrigin}${href})`;
        }) +
      (page.slug === "connect"
        ? `\nOpen the [interactive connection helper](${docsOrigin}/docs/connect) on the PhoneUse documentation site.\n`
        : ""),
  );
  full += md + "\n---\n\n";
}
write("public/llms-full.txt", full);
write(
  "public/llms.txt",
  "# PhoneUse\n\n> Physical device control through browser, REST, and MCP. Use customer keys for assigned remote devices.\n\n" +
    pages
      .map(
        (p) =>
          `- [${p.title}](${docsOrigin}/docs/${p.slug}.md): ${p.description}`,
      )
      .join("\n") +
    `\n\n- [Remote OpenAPI](${docsOrigin}/openapi-remote.json)\n`,
);
write(
  "public/agent-guide.txt",
  readFileSync(resolve(root, "public/docs/mcp.md"), "utf8") +
    "\n" +
    readFileSync(resolve(root, "public/docs/mcp-tools.md"), "utf8") +
    "\n" +
    readFileSync(resolve(root, "public/docs/actions.md"), "utf8"),
);
const groups = [...new Set(pages.map((p) => p.group))].map((group) => ({
  group,
  pages: pages.filter((p) => p.group === group).map((p) => p.slug),
}));
write(
  "docs/mintlify/docs.json",
  JSON.stringify(
    {
      $schema: "https://mintlify.com/docs.json",
      theme: "mint",
      name: "PhoneUse",
      colors: { primary: "#087f67", light: "#20a486", dark: "#065f4e" },
      navigation: {
        tabs: [
          { tab: "Documentation", groups },
          { tab: "API reference", openapi: "openapi-remote.json" },
        ],
      },
      navbar: {
        links: [
          {
            label: "Console",
            href: `${docsOrigin}/console`,
          },
        ],
      },
    },
    null,
    2,
  ) + "\n",
);
write(
  "docs/mintlify/openapi-remote.json",
  JSON.stringify(remote, null, 2) + "\n",
);
write(
  "public/sitemap.xml",
  '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    ["/", ...pages.map((p) => "/docs/" + p.slug)]
      .map(
        (path) =>
          `<url><loc>${docsOrigin}${path}</loc></url>`,
      )
      .join("") +
    "</urlset>\n",
);
write(
  "public/robots.txt",
  `User-agent: *\nAllow: /\nDisallow: /console\nDisallow: /calibrate\nSitemap: ${docsOrigin}/sitemap.xml\n`,
);
mkdirSync(resolve(root, "public/examples"), { recursive: true });
for (const extension of ["mjs", "py"])
  write(
    `public/examples/remote-inspect.${extension}`,
    readFileSync(resolve(root, `examples/remote/inspect.${extension}`), "utf8"),
  );
console.log(
  `Generated ${pages.length} Markdown/MDX guides, remote OpenAPI, and documentation indexes.`,
);
