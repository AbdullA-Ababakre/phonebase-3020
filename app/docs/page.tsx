import type { Metadata } from "next";
import { DocsContent } from "./docs-content";
export const metadata: Metadata = {
  title: "PhoneUse Docs | Build on real devices",
  description:
    "Connect to your assigned physical devices through the Cloud Console, REST API, or MCP. Remote quickstarts, API reference, and operator guides.",
};
export default function DocsPage() {
  return <DocsContent />;
}
