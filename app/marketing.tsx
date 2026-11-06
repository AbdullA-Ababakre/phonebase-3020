import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Code,
  CursorClick,
  DeviceMobile,
  Key,
  Robot,
  Stack,
  TerminalWindow,
} from "@phosphor-icons/react/dist/ssr";
import styles from "./marketing.module.css";
export function MarketingPage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/">
          <DeviceMobile size={24} weight="duotone" />
          phoneuse
        </Link>
        <nav>
          <Link href="/docs">Documentation</Link>
          <Link href="/docs/api-reference">API</Link>
          <Link href="/docs/enterprise-evaluation">Enterprise</Link>
        </nav>
        <Link className={styles.console} href="/console">
          Open console <ArrowUpRight size={15} />
        </Link>
      </header>
      <main>
        <section className={styles.hero}>
          <div className={styles.eyebrow}><span /> REAL PHONES FOR AI AGENTS</div>
          <h1>
            Your agent.
            <br />
            A real phone.
          </h1>
          <p>
            Let an AI agent see and operate a retail phone through a camera and physical stylus.
            <br className={styles.desktopBreak} /> Use the browser, REST API, or one MCP connection.
          </p>
          <div className={styles.actions}>
            <Link href="/console">
              Open PhoneUse console <ArrowRight size={16} />
            </Link>
            <Link href="/docs/enterprise-evaluation">
              Plan an enterprise trial <ArrowUpRight size={16} />
            </Link>
          </div>
          <div className={styles.heroNote}>
            <Key size={14} /> Retail devices · Physical input · Receipt-backed actions
          </div>
          <div className={styles.system}>
            <div className={styles.systemHead}>
              <span>
                <TerminalWindow size={15} /> phoneuse / live device session
              </span>
              <small>ILLUSTRATIVE WORKFLOW</small>
            </div>
            <div className={styles.systemGrid}>
              <div className={styles.code}>
                <span className={styles.comment}>
                  {"// Connect your application to a real device."}
                </span>
                <p>
                  <b>const</b> devices = <b>await</b> listDevices();
                  <br />
                  <b>const</b> device = devices[0];
                  <br />
                  <b>const</b> frame = <b>await</b> screenshot(device.id);
                </p>
                <p>
                  <b>const</b> receipt = <b>await</b> act(device.id, {"{"}
                  <br />
                  &nbsp; type: <em>&quot;tap&quot;</em>,<br />
                  &nbsp; point: targetFrom(frame),
                  <br />
                  &nbsp; viewport: frame.viewport,
                  <br />
                  &nbsp; frameSequence: frame.sequence
                  <br />
                  {"}"});
                </p>
                <p>
                  <b>await</b> waitForCompletion(receipt.id);
                </p>
                <span className={styles.comment}>
                  {"// Observe again. Verify the outcome."}
                </span>
              </div>
              <div className={styles.deviceIllustration}>
                <div className={styles.deviceOrbit}>
                  <div className={styles.phone}>
                    <div className={styles.speaker} />
                    <div className={styles.phoneHeader}>
                      <DeviceMobile size={22} />
                      <span>Physical device</span>
                    </div>
                    <div className={styles.phoneLines}>
                      <i />
                      <i />
                      <i />
                    </div>
                    <div className={styles.touchTarget}>
                      <CursorClick size={28} />
                    </div>
                    <div className={styles.phoneBottom} />
                  </div>
                  <div className={styles.cameraTag}>01 / OBSERVE</div>
                  <div className={styles.actionTag}>02 / ACT</div>
                  <div className={styles.receiptTag}>03 / VERIFY</div>
                </div>
              </div>
            </div>
            <div className={styles.systemFooter}>
              <span>REST API</span>
              <span>WebSocket video</span>
              <span>MCP tools</span>
              <Link href="/docs/actions">
                Explore the control contract <ArrowRight size={13} />
              </Link>
            </div>
          </div>
        </section>
        <section className={styles.paths}>
          <div className={styles.sectionIntro}>
            <span>ONE PLATFORM. YOUR WAY TO BUILD.</span>
            <h2>
              From a first connection
              <br />
              to a product of your own.
            </h2>
            <p>
              Start with the interface that fits your work. Every path reaches
              the same assigned hardware and the same physical controls.
            </p>
          </div>
          <div className={styles.cards}>
            {[
              {
                icon: CursorClick,
                title: "Operate in the browser",
                text: "Inspect the live phone, check readiness, and operate assigned devices from the Cloud Console.",
                href: "/docs/console",
                label: "Explore the console",
              },
              {
                icon: Code,
                title: "Build with the API",
                text: "Compose physical actions into QA systems, testing tools, and your own device workflows.",
                href: "/docs/api-reference",
                label: "Read the API reference",
              },
              {
                icon: Robot,
                title: "Connect your agents",
                text: "Give an MCP-compatible agent host observation and control tools, with explicit execution receipts.",
                href: "/docs/mcp",
                label: "Set up MCP",
              },
            ].map((item) => (
              <Link key={item.href} href={item.href}>
                <item.icon size={26} weight="light" />
                <h3>{item.title}</h3>
                <p>{item.text}</p>
                <span>
                  {item.label}
                  <ArrowUpRight size={15} />
                </span>
              </Link>
            ))}
          </div>
        </section>
        <section className={styles.fleet}>
          <div>
            <span className={styles.eyebrow}>
              BUILT AROUND ASSIGNED HARDWARE
            </span>
            <h2>
              A workspace for your customer.
              <br />
              Control of your fleet.
            </h2>
            <p>
              Bring devices online at your station. Assign them to a company or
              developer team. Deliver a private key that works across the
              console, API, and MCP.
            </p>
            <Link href="/docs/customer-access">
              See the operator workflow <ArrowRight size={16} />
            </Link>
          </div>
          <div className={styles.allocations}>
            <div>
              <Stack size={19} />
              <strong>Station → customer access</strong>
              <small>CONCEPT</small>
            </div>
            {[
              ["Team A", "Device 01", "Device 02"],
              ["Team B", "Device 03", "Device 04"],
            ].map(([team, ...devices]) => (
              <article key={team}>
                <span>{team}</span>
                <div>
                  {devices.map((device) => (
                    <code key={device}>{device}</code>
                  ))}
                </div>
                <Key size={15} />
              </article>
            ))}
            <p>Device-scoped access. Renewable grants. Explicit revocation.</p>
          </div>
        </section>
        <section className={styles.enterprise}>
          <span>ENTERPRISE EVALUATION</span>
          <h2>Test it against your real workflow.</h2>
          <p>
            Start with assigned trial devices. Verify the integration, physical
            outcomes, and recovery behavior. Build a measured foundation for a
            larger deployment.
          </p>
          <Link href="/docs/enterprise-evaluation">
            Explore the evaluation guide <ArrowRight size={16} />
          </Link>
        </section>
      </main>
      <footer className={styles.footer}>
        <Link className={styles.brand} href="/">
          <DeviceMobile size={22} weight="duotone" />
          phoneuse
        </Link>
        <span>Software meets physical devices.</span>
        <nav>
          <Link href="/docs">Developers</Link>
          <Link href="/docs/security">Security</Link>
          <Link href="/docs/changelog">Changelog</Link>
        </nav>
      </footer>
    </div>
  );
}
