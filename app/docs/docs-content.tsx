"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpenText,
  Check,
  CirclesFour,
  Code,
  DeviceMobile,
  Copy,
  Key,
  MagnifyingGlass,
  List,
  Robot,
  X,
} from "@phosphor-icons/react";
import pageData from "../../content/docs/pages.json";
import specification from "../../public/openapi-remote.json";
import {
  remoteEndpointFromAccessCode,
  rememberRemoteEndpoint,
  resolveControlPlaneEndpoint,
  type ControlPlaneEndpoint,
} from "../control-plane-endpoint";
import styles from "./docs.module.css";

type Block = {
  type: string;
  text?: string;
  language?: string;
  label?: string;
  value?: string;
  items?: (string | { title: string; text: string; href: string })[];
  headers?: string[];
  rows?: string[][];
};
type DocPage = {
  slug: string;
  title: string;
  description: string;
  group: string;
  sections: { id: string; title: string; blocks: Block[] }[];
};
const pages = pageData as DocPage[];
const groups = [...new Set(pages.map((page) => page.group))];

function Inline({ children }: { children: string }) {
  const parts = children.split(/(`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("`"))
          return <code key={index}>{part.slice(1, -1)}</code>;
        const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (link)
          return (
            <a key={index} href={link[2]}>
              {link[1]}
            </a>
          );
        return part;
      })}
    </>
  );
}

export function CodeBlock({
  label,
  value,
  language = "text",
}: {
  label: string;
  value: string;
  language?: string;
}) {
  const [status, setStatus] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("Copied");
    } catch {
      setStatus("Select text to copy");
    }
  }
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 2500);
    return () => clearTimeout(timer);
  }, [status]);
  return (
    <div className={styles.codeBlock}>
      <div>
        <span>{label}</span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy ${label}`}
        >
          {status === "Copied" ? <Check size={14} /> : <Copy size={14} />}
          <span aria-live="polite">{status || "Copy"}</span>
        </button>
      </div>
      <pre tabIndex={0}>
        <code data-language={language}>{value}</code>
      </pre>
    </div>
  );
}

type Schema = {
  $ref?: string;
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
  allOf?: Schema[];
  anyOf?: Schema[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minLength?: number;
  additionalProperties?: unknown;
};
const spec = specification as unknown as {
  paths: Record<
    string,
    Record<
      string,
      {
        summary: string;
        description?: string;
        parameters?: {
          $ref?: string;
          name?: string;
          in?: string;
          required?: boolean;
          schema?: Schema;
          description?: string;
        }[];
        requestBody?: { content: Record<string, { schema: Schema }> };
        responses: Record<
          string,
          {
            $ref?: string;
            description?: string;
            content?: Record<string, { schema?: Schema }>;
          }
        >;
      }
    >
  >;
  components: Record<string, Record<string, unknown>>;
};
function deref<T extends { $ref?: string }>(value: T): T {
  if (!value.$ref) return value;
  return value.$ref
    .split("/")
    .slice(1)
    .reduce(
      (obj, key) => (obj as Record<string, unknown>)?.[key],
      spec as unknown,
    ) as T;
}
function SchemaView({ schema, depth = 0 }: { schema: Schema; depth?: number }) {
  const resolved = deref(schema);
  if (!resolved) return null;
  if (depth > 3)
    return <a href="/openapi-remote.json">See complete schema ↗</a>;
  const alternatives = resolved.oneOf ?? resolved.anyOf ?? resolved.allOf;
  return (
    <div className={styles.schema}>
      {resolved.description && <p>{resolved.description}</p>}
      {alternatives?.map((item, i) => (
        <details key={i}>
          <summary>{item.$ref?.split("/").pop() ?? `Variant ${i + 1}`}</summary>
          <SchemaView schema={item} depth={depth + 1} />
        </details>
      ))}
      {Object.entries(resolved.properties ?? {}).map(([name, value]) => {
        const field = deref(value);
        return (
          <div key={name}>
            <code>{name}</code>
            <span>
              {field.type ?? (field.oneOf ? "one of" : "object")}{" "}
              {resolved.required?.includes(name) && <b>required</b>}
            </span>
            {field.description && <p>{field.description}</p>}
            {field.enum && (
              <p>
                Allowed: {field.enum.map((v) => JSON.stringify(v)).join(", ")}
              </p>
            )}
            {field.const !== undefined && (
              <p>Value: {JSON.stringify(field.const)}</p>
            )}
            {(field.minimum !== undefined || field.maximum !== undefined) && (
              <p>
                Range: {field.minimum ?? "—"} to {field.maximum ?? "—"}
              </p>
            )}
            {(field.properties || field.oneOf || field.allOf) && (
              <details>
                <summary>Properties</summary>
                <SchemaView schema={field} depth={depth + 1} />
              </details>
            )}
            {field.items && (
              <details>
                <summary>Array item</summary>
                <SchemaView schema={field.items} depth={depth + 1} />
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
function ApiReference() {
  return (
    <div className={styles.apiReference}>
      {Object.entries(spec.paths).flatMap(([path, methods]) =>
        Object.entries(methods).map(([method, op]) => (
          <article
            className={styles.endpoint}
            key={method + path}
            id={`${method}-${path.replace(/[^a-z0-9]/gi, "-")}`}
          >
            <div className={styles.endpointPath}>
              <b data-method={method}>{method.toUpperCase()}</b>
              <code>{path}</code>
            </div>
            <h3>{op.summary}</h3>
            {op.description && <p>{op.description}</p>}
            {op.parameters?.length ? (
              <div className={styles.tableWrap}>
                <table>
                  <thead>
                    <tr>
                      <th>Parameter</th>
                      <th>Location</th>
                      <th>Requirement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {op.parameters.map((raw) => {
                      const parameter = deref(raw);
                      return (
                        <tr key={parameter.name}>
                          <td>
                            <code>{parameter.name}</code>
                            {parameter.description && (
                              <small>{parameter.description}</small>
                            )}
                          </td>
                          <td>{parameter.in}</td>
                          <td>
                            {parameter.required ? "Required" : "Optional"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
            {op.requestBody && (
              <details>
                <summary>Request body · application/json</summary>
                <SchemaView
                  schema={op.requestBody.content["application/json"].schema}
                />
              </details>
            )}
            <div className={styles.responses}>
              {Object.entries(op.responses).map(([status, raw]) => {
                const response = deref(raw);
                return (
                  <details key={status}>
                    <summary>
                      <code>{status}</code> {response.description}
                    </summary>
                    {Object.entries(response.content ?? {}).map(
                      ([type, body]) => (
                        <div key={type}>
                          <small>{type}</small>
                          {body.schema && <SchemaView schema={body.schema} />}
                        </div>
                      ),
                    )}
                  </details>
                );
              })}
            </div>
          </article>
        )),
      )}
    </div>
  );
}

function ConnectionHelper() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [connection, setConnection] = useState<ControlPlaneEndpoint | null>(
    null,
  );
  const [error, setError] = useState("");
  const [reveal, setReveal] = useState(false);
  const [bridgePath, setBridgePath] = useState("");
  const hasAbsoluteBridgePath = /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(bridgePath.trim());
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = resolveControlPlaneEndpoint({ remoteOnly: true });
      if (saved.endpoint?.remote) setConnection(saved.endpoint);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const token = connection
    ? reveal
      ? connection.accessToken
      : "YOUR_API_KEY"
    : "YOUR_API_KEY";
  const shellQuote = (text: string) =>
    "'" + text.replaceAll("'", "'\\''") + "'";
  const config = JSON.stringify(
    {
      mcpServers: {
        phonebase: {
          command: "node",
          args: [bridgePath.trim()],
          env: {
            PHONEBASE_API_URL:
              connection?.baseUrl ?? "https://gateway.phonebase.co",
            PHONEBASE_API_TOKEN: token,
            PHONEBASE_MCP_ALLOW_REMOTE: "1",
          },
        },
      },
    },
    null,
    2,
  );
  return (
    <section
      className={styles.connectionHelper}
      aria-label="Private connection helper"
    >
      {!connection && <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = remoteEndpointFromAccessCode(value);
          setConnection(parsed);
          setReveal(false);
          setError(
            parsed
              ? ""
              : "Enter your complete PB access code or private invitation link.",
          );
          if (parsed) setValue("");
        }}
      >
        <label htmlFor="private-invitation">Private invitation</label>
        <div>
          <input
            id="private-invitation"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Paste a customer link or access code"
            maxLength={2048}
            required
          />
          <button type="submit">
            Prepare connection <ArrowRight size={16} />
          </button>
        </div>
        <small>Decoded in this tab. No network request is made.</small>
        {error && <p role="alert">{error}</p>}
      </form>}
      {connection && (
        <>
          <div className={styles.connectionResult}>
            <span>
              <Check size={18} /> Connection settings ready · use Console to verify access
            </span>
            <button
              type="button"
              onClick={() => {
                setConnection(null);
                setValue("");
                setReveal(false);
              }}
            >
              Change invitation
            </button>
          </div>
          <p>
            Gateway: <code>{connection.baseUrl}</code>
          </p>
          <label className={styles.reveal}>
            <input
              type="checkbox"
              checked={reveal}
              onChange={(e) => setReveal(e.target.checked)}
            />{" "}
            Include my private key in the copyable examples
          </label>
          <CodeBlock
            label="REST · read assigned devices"
            value={`curl --fail-with-body ${shellQuote(connection.baseUrl + "/api/v1/devices")} \\\n  -H ${shellQuote("Authorization: Bearer " + token)}`}
          />
          <label htmlFor="mcp-bridge-path">MCP client file path</label>
          <input id="mcp-bridge-path" type="text" value={bridgePath}
            onChange={(event) => setBridgePath(event.target.value)}
            placeholder="Full path to phonebase-mcp.mjs" spellCheck={false} />
          <p className={styles.helperNote}>Download the client from the <Link href="/docs/mcp">MCP setup guide</Link>, then paste its full file path here. Your configuration updates automatically. Node.js must be available to your agent host.</p>
          {hasAbsoluteBridgePath && reveal ? <CodeBlock
            label="MCP · agent configuration"
            language="json"
            value={config}
          /> : <p className={styles.helperNote}>Enter an absolute client file path and enable “Include my private key” to generate a complete MCP configuration. For automatic path detection and connection verification, run <code>node phonebase-mcp.mjs --configure</code> instead.</p>}
          <button className={styles.continueButton} type="button" onClick={() => {
            try { rememberRemoteEndpoint(connection); router.push("/console"); }
            catch { setError("Your browser could not save this connection. Open the Console and paste your invitation there."); }
          }}>Continue to your workspace <ArrowRight size={16} /></button>
          <p className={styles.helperNote}>
            Your invitation carries over in this tab. The Console verifies your access with the station. Changing the invitation here does not disconnect your existing Console session or revoke its key.
          </p>
        </>
      )}
    </section>
  );
}

function RenderBlock({ block }: { block: Block }) {
  switch (block.type) {
    case "text":
      return (
        <p>
          <Inline>{block.text ?? ""}</Inline>
        </p>
      );
    case "note":
      return (
        <aside className={styles.note}>
          <span>Note</span>
          <p>
            <Inline>{block.text ?? ""}</Inline>
          </p>
        </aside>
      );
    case "code":
      return (
        <CodeBlock
          label={block.label ?? "Example"}
          value={block.value ?? ""}
          language={block.language}
        />
      );
    case "list":
      return (
        <ul className={styles.list}>
          {(block.items as string[]).map((item, i) => (
            <li key={i}>
              <Inline>{item}</Inline>
            </li>
          ))}
        </ul>
      );
    case "cards":
      return (
        <div className={styles.cards}>
          {(block.items as { title: string; text: string; href: string }[]).map(
            (item) => (
              <Link href={item.href} key={item.href}>
                <ArrowUpRight size={18} />
                <strong>{item.title}</strong>
                <span>{item.text}</span>
              </Link>
            ),
          )}
        </div>
      );
    case "table":
      return (
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                {block.headers?.map((header) => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows?.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>
                      <Inline>{cell}</Inline>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "api":
      return <ApiReference />;
    default:
      return null;
  }
}

export function DocsContent({ slug = "overview" }: { slug?: string }) {
  const page = pages.find((p) => p.slug === slug) ?? pages[0];
  const [menu, setMenu] = useState(false);
  const [quickstartPath, setQuickstartPath] = useState<"browser" | "api" | "mcp">("browser");
  const visibleSections = page.slug !== "quickstart" ? page.sections : page.sections.filter(section => {
    if (["requirements", "next"].includes(section.id)) return true;
    if (quickstartPath === "browser") return ["connect", "browser-control"].includes(section.id);
    if (quickstartPath === "mcp") return section.id === "agent-start";
    return !["browser-control", "agent-start"].includes(section.id);
  });
  useEffect(() => {
    if (page.slug !== "quickstart") return;
    const updatePath = () => {
      const url = new URL(window.location.href);
      const path = url.searchParams.get("path");
      const hash = url.hash.slice(1);
      setQuickstartPath(path === "mcp" || hash === "agent-start" ? "mcp" : path === "api" || ["credentials", "list", "observe", "runnable-examples"].includes(hash) ? "api" : "browser");
    };
    const timer = window.setTimeout(updatePath, 0);
    window.addEventListener("hashchange", updatePath);
    window.addEventListener("popstate", updatePath);
    return () => { window.clearTimeout(timer); window.removeEventListener("hashchange", updatePath); window.removeEventListener("popstate", updatePath); };
  }, [page.slug]);
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const current = pages.findIndex((p) => p.slug === page.slug);
  const results = pages
    .filter((p) =>
      `${p.title} ${p.description} ${JSON.stringify(p.sections)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .slice(0, 12);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        dialog.current?.showModal();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  function openSearch() {
    dialog.current?.showModal();
    searchInput.current?.focus();
  }
  return (
    <div className={styles.docs}>
      <a className={styles.skip} href="#main-content">
        Skip to content
      </a>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          <span>
            <CirclesFour size={23} weight="fill" />
          </span>
          <strong>phoneuse</strong>
          <em>docs</em>
        </Link>
        <button
          className={styles.searchButton}
          aria-label="Search documentation"
          type="button"
          onClick={openSearch}
        >
          <MagnifyingGlass size={17} />
          <span>Search documentation</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav aria-label="Main navigation">
          <Link href="/docs/enterprise-evaluation">Enterprise</Link>
          <Link href="/console" className={styles.consoleButton}>
            Open console <ArrowUpRight size={14} />
          </Link>
        </nav>
        <button
          type="button"
          className={styles.mobileToggle}
          aria-label="Toggle documentation navigation"
          aria-expanded={menu}
          aria-controls="docs-sidebar"
          onClick={() => setMenu(!menu)}
        >
          {menu ? <X size={22} /> : <List size={22} />}
        </button>
      </header>
      <div className={styles.tabs}>
        <Link
          href="/docs"
          data-active={!["api-reference", "mcp", "mcp-tools"].includes(slug)}
        >
          Documentation
        </Link>
        <Link href="/docs/api-reference" data-active={slug === "api-reference"}>
          API reference
        </Link>
        <Link href="/docs/mcp" data-active={slug.startsWith("mcp")}>
          Build with agents
        </Link>
        <a href="/llms.txt">
          llms.txt <ArrowUpRight size={12} />
        </a>
      </div>
      <div className={styles.layout}>
        <aside
          id="docs-sidebar"
          className={`${styles.sidebar} ${menu ? styles.sidebarOpen : ""}`}
        >
          <nav aria-label="Documentation navigation">
            {groups.map((group) => (
              <section key={group}>
                <h2>{group}</h2>
                {pages
                  .filter((p) => p.group === group)
                  .map((p) => (
                    <Link
                      key={p.slug}
                      href={p.slug === "overview" ? "/docs" : `/docs/${p.slug}`}
                      aria-current={p.slug === page.slug ? "page" : undefined}
                      onClick={() => setMenu(false)}
                    >
                      {p.slug === "overview" && <BookOpenText size={16} />}{" "}
                      {p.slug === "mcp" && <Robot size={16} />}{" "}
                      {p.slug === "authentication" && <Key size={16} />}{" "}
                      {p.slug === "api-reference" && <Code size={16} />}{" "}
                      {p.title}
                    </Link>
                  ))}
              </section>
            ))}
          </nav>
          <div className={styles.sidebarFooter}>
            <span>Developer resources</span>
            <a href="/openapi-remote.json">
              OpenAPI 3.1.2 <ArrowUpRight size={13} />
            </a>
            <a href="/agent-guide.txt">
              Agent handoff <ArrowUpRight size={13} />
            </a>
          </div>
        </aside>
        <main className={styles.content} id="main-content">
          <div className={styles.breadcrumb}>
            {page.group}
            <span>/</span>
            {page.slug === "overview" ? "Introduction" : page.title}
          </div>
          <div className={styles.titleRow}>
            <span className={styles.eyebrow}>PHONEUSE DEVELOPERS</span>
            <a
              href={`/docs/${page.slug}.md`}
              aria-label="Open this page as Markdown"
            >
              <Copy size={14} /> Markdown
            </a>
          </div>
          <h1>{page.title}</h1>
          <p className={styles.lead}>{page.description}</p>
          {page.slug === "quickstart" && <div className={styles.pathPicker} aria-label="Choose how to connect">
            <span>How do you want to use PhoneUse?</span>
            <div>{([
              ["browser", "Use the browser", DeviceMobile],
              ["api", "Build with the API", Code],
              ["mcp", "Connect an agent", Robot],
            ] as const).map(([id, label, Icon]) => <button key={id} type="button" aria-pressed={quickstartPath === id} onClick={() => { setQuickstartPath(id); const url = new URL(window.location.href); url.searchParams.set("path", id); url.hash = ""; window.history.replaceState(window.history.state, "", url); }}><Icon size={18} />{label}</button>)}</div>
            <p>{quickstartPath === "browser" ? "No installation or code required. Your operator prepares the hardware." : quickstartPath === "api" ? "Make your first read-only request, then inspect a live frame." : "Connect your agent host through the standalone MCP bridge."}</p>
          </div>}
          {visibleSections.map((section, index) => (
            <section
              id={section.id}
              key={section.id}
              className={styles.section}
            >
              <h2>
                <a href={`#${section.id}`}>
                  {section.title}
                  <span>#</span>
                </a>
              </h2>
              {section.blocks.map((block, i) => (
                <RenderBlock key={i} block={block} />
              ))}
              {((page.slug === "connect" && index === 0) || (page.slug === "mcp" && section.id === "configuration")) && <ConnectionHelper />}
            </section>
          ))}
          <nav className={styles.pager} aria-label="Adjacent pages">
            {current > 0 ? (
              <Link href={`/docs/${pages[current - 1].slug}`}>
                <small>Previous</small>
                <strong>← {pages[current - 1].title}</strong>
              </Link>
            ) : (
              <span />
            )}
            {current < pages.length - 1 && (
              <Link href={`/docs/${pages[current + 1].slug}`}>
                <small>Next</small>
                <strong>{pages[current + 1].title} →</strong>
              </Link>
            )}
          </nav>
          <footer className={styles.footer}>
            <span>PhoneUse · Physical device infrastructure</span>
            <Link href="/docs/security">Security & responsibilities</Link>
          </footer>
        </main>
        <aside className={styles.toc}>
          <span>On this page</span>
          {visibleSections.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              {section.title}
            </a>
          ))}
          <div>
            <Key size={18} />
            <strong>Have an invitation?</strong>
            <p>Get the settings for your app or agent.</p>
            <Link href="/docs/connect">
              Prepare connection <ArrowRight size={13} />
            </Link>
          </div>
        </aside>
      </div>
      <dialog
        ref={dialog}
        className={styles.searchDialog}
        aria-label="Search documentation"
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current.close();
        }}
      >
        <div className={styles.searchInput}>
          <MagnifyingGlass size={21} />
          <input
            ref={searchInput}
            aria-label="Search documentation"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search guides, API, errors…"
          />
          <button
            type="button"
            aria-label="Close search"
            onClick={() => dialog.current?.close()}
          >
            <X size={18} />
          </button>
        </div>
        <div className={styles.searchResults}>
          <span aria-live="polite">
            {query
              ? `${results.length} matching pages`
              : "Explore the documentation"}
          </span>
          {results.map((result) => (
            <Link
              key={result.slug}
              href={`/docs/${result.slug}`}
              onClick={() => dialog.current?.close()}
            >
              <strong>
                {result.title}
                <ArrowUpRight size={16} />
              </strong>
              <p>{result.description}</p>
              <small>{result.group}</small>
            </Link>
          ))}
          {!results.length && (
            <p>No pages found. Try “key”, “MCP”, or “screenshot”.</p>
          )}
        </div>
      </dialog>
    </div>
  );
}
